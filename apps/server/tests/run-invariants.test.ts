import type { LLMProvider } from '@mini-agent-run/ai';
import type { InvestigationRun } from '@mini-agent-run/shared';
import fc from 'fast-check';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createSqliteArtifactStore } from '../src/db/artifact-store.js';
import { openAppDatabase, recoverStaleRuns } from '../src/db/database.js';
import { createSqliteRunStore } from '../src/db/run-repository.js';
import { createSession } from '../src/db/session-repository.js';
import { createServerTraceWorkspace } from '../src/fs/trace-workspace.js';
import { isActiveRun, RunCoordinatorError } from '../src/runtime/ports.js';
import { createRunCoordinator } from '../src/runtime/run-coordinator.js';

const operation = fc.record({
  kind: fc.constantFrom('start', 'stop', 'retry', 'lateFinishAttempt', 'restartRecover'),
  pick: fc.nat(12),
  race: fc.boolean(),
});

const provider: LLMProvider = {
  name: 'fixture',
  async *stream({ signal }) {
    if (signal && !signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
    yield { type: 'done', stopReason: 'stop' };
  },
};

const lateEnd = { type: 'agent_end', status: 'completed', stopReason: 'completed', durationMs: 0 } as const;

type StoredRun = Pick<InvestigationRun, 'id' | 'status'> & { session_id: string; last_seq: number };
type StoredEvent = { run_id: string; seq: number; event_type: string; payload_type: string };

describe('F06_RUN_STOP_AND_INVARIANTS SQLite and runtime state machine', () => {
  it('preserves four AgentRun.tla properties over generated start/stop/retry/recovery interleavings', async () => {
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 8, maxLength: 15 }), async (operations) => {
      const db = openAppDatabase(':memory:');
      const store = createSqliteRunStore(db);
      const coordinator = createRunCoordinator({
        store, artifactStore: createSqliteArtifactStore(db),
        resolveProvider: () => ({ provider, modelId: 'fixture', providerName: provider.name }),
        createWorkspace: createServerTraceWorkspace, resolveAllowedRoots: () => [], toolMode: 'mock',
      });
      const sessions = ['/fixture/a', '/fixture/b'].map((targetPath) =>
        createSession(db, { targetPath, pathType: 'dir' }).id);
      const terminals = new Map<string, StoredRun>();
      const readRuns = db.prepare<[], StoredRun>('SELECT * FROM investigation_runs ORDER BY created_at, rowid');
      const readEvents = db.prepare<[], StoredEvent>(`
        SELECT run_id, seq, event_type, json_extract(payload_json, '$.type') AS payload_type
        FROM run_events ORDER BY run_id, seq
      `);
      const activeCount = db.prepare<[], number>(`
        SELECT count(*) FROM investigation_runs WHERE status IN ('pending', 'running')
      `).pluck();

      function assertState() {
        // Check the same persisted rows after every operation with two bulk reads.
        const events = new Map<string, { count: number; endSeq: number | null }>();
        for (const { run_id: runId, seq, event_type: type, payload_type: payloadType } of readEvents.all()) {
          assert.equal(payloadType, type, 'Stored event type must match its payload');
          const stats = events.get(runId) ?? { count: 0, endSeq: null };
          assert.equal(seq, ++stats.count, 'Run event sequences must be contiguous');
          if (type === 'agent_end') {
            assert.equal(stats.endSeq, null, 'A run must have at most one agent_end');
            stats.endSeq = seq;
          }
          events.set(runId, stats);
        }
        const activeSessions = new Set<string>();
        for (const run of readRuns.all()) {
          const stats = events.get(run.id);
          assert.equal(run.last_seq, stats?.count ?? 0);
          if (isActiveRun(run.status)) {
            assert.ok(!activeSessions.has(run.session_id), 'OneActiveRunPerSession');
            activeSessions.add(run.session_id);
            assert.equal(stats?.endSeq ?? null, null, 'An active run cannot have agent_end');
          } else {
            assert.equal(stats?.endSeq, run.last_seq, 'A terminal run must end with agent_end');
            const previous = terminals.get(run.id);
            if (previous) assert.deepStrictEqual(run, previous, 'TerminalIrreversible');
            else terminals.set(run.id, run);
          }
        }
      }

      function attempt(action: () => InvestigationRun) {
        try { return action(); } catch (error) {
          if (!(error instanceof RunCoordinatorError)) throw error;
          expect(['SESSION_HAS_ACTIVE_RUN', 'RUN_STILL_ACTIVE', 'RUN_NOT_RETRYABLE', 'RETRY_LIMIT_EXCEEDED'])
            .toContain(error.code);
          return null;
        }
      }

      try {
        const first = sessions[0];
        if (!first) throw new Error('Missing fixture session.');
        const start = (id: string) => coordinator.startRun(id, { prompt: 'Run' });
        const initial = await Promise.all([
          Promise.resolve().then(() => attempt(() => start(first))),
          Promise.resolve().then(() => attempt(() => start(first))),
        ]);
        expect(initial.filter(Boolean)).toHaveLength(1);
        assertState();
        for (const { kind, pick, race } of operations) {
          const session = sessions[pick % sessions.length];
          if (!session) throw new Error('Missing fixture session.');
          const runs = readRuns.all().filter((entry) => entry.session_id === session);
          const run = runs[pick % runs.length];
          switch (kind) {
            case 'start':
              attempt(() => start(session));
              break;
            case 'retry':
              if (run) attempt(() => coordinator.retryRun(run.id, {}));
              break;
            case 'stop': {
              const active = runs.find((candidate) => isActiveRun(candidate.status));
              if (!active) break;
              const before = coordinator.activeRunCount;
              if (race) await nextTurn();
              expect(coordinator.stopRun(active.id)).toMatchObject({ status: 'stopping' });
              assertState();
              await nextTurn();
              await nextTurn();
              expect(store.getRun(active.id), 'CancelBoundedConvergence').toMatchObject({
                status: 'stopped', stopReason: 'user_abort',
              });
              expect(coordinator.activeRunCount).toBe(before - 1);
              break;
            }
            case 'lateFinishAttempt': {
              const terminal = runs.find((candidate) => !isActiveRun(candidate.status));
              if (!terminal) break;
              const timestamp = new Date().toISOString();
              expect(store.finishRun(terminal.id, timestamp, lateEnd)).toEqual({ updated: false });
              expect(store.appendEvents(terminal.id, [{ type: 'turn_start', step: 1 }])).toEqual([]);
              break;
            }
            case 'restartRecover': {
              await coordinator.shutdown();
              for (const sessionId of sessions) {
                const stale = store.createRun({
                  sessionId, prompt: 'Stale', modelId: 'fixture', modelProvider: 'fixture', maxSteps: 12, toolMode: 'mock',
                });
                if (race) store.markRunning(stale.id, new Date().toISOString());
                store.appendEvents(stale.id, [{ type: 'turn_start', step: 1 }]);
              }
              assertState();
              expect(recoverStaleRuns(db)).toBe(sessions.length);
              expect(activeCount.get(), 'NoZombiesAfterRestart').toBe(0);
              expect(coordinator.activeRunCount).toBe(0);
              break;
            }
          }
          if (race) await nextTurn();
          assertState();
        }
        await coordinator.shutdown();
        assertState();
        expect(activeCount.get()).toBe(0);
        expect(coordinator.activeRunCount).toBe(0);
      } finally {
        await coordinator.shutdown();
        db.close();
      }
    }), { numRuns: 80 });
  });
});
