import { createMockLLMProvider } from '@mini-agent-run/ai';
import { describe, expect, it } from 'vitest';
import { createSqliteArtifactStore } from '../src/db/artifact-store.js';
import { openAppDatabase } from '../src/db/database.js';
import { createSqliteRunStore } from '../src/db/run-repository.js';
import { createSession } from '../src/db/session-repository.js';
import { createServerTraceWorkspace } from '../src/fs/trace-workspace.js';
import { createRunCoordinator } from '../src/runtime/run-coordinator.js';
import { createRunRedactor } from '../src/runtime/run-redaction.js';

async function withRun(test: (coordinator: ReturnType<typeof createRunCoordinator>, sessionId: string) => Promise<void>) {
  const db = openAppDatabase(':memory:');
  const session = createSession(db, { targetPath: '/fixture', pathType: 'dir' });
  const key = 'fixture-' + 'private';
  const provider = createMockLLMProvider({ turns: [{ text: 'begin ' + key + ' end', chunkSize: 1 }] });
  const coordinator = createRunCoordinator({
    store: createSqliteRunStore(db), artifactStore: createSqliteArtifactStore(db), createWorkspace: createServerTraceWorkspace,
    resolveProvider: () => ({
      provider, providerName: provider.name, modelId: 'fixture', redactor: createRunRedactor([key]),
    }),
    resolveAllowedRoots: () => [], toolMode: 'mock', coalesceWindowMs: 15, coalesceMaxChars: 4,
  });
  try {
    await test(coordinator, session.id);
  } finally {
    await coordinator.shutdown();
    db.close();
  }
}

describe('M2.3 Run coordinator', () => {
  it('settles a stop issued before background work, including repeated stop and subscriber cleanup', () =>
    withRun(async (coordinator, sessionId) => {
      const run = coordinator.startRun(sessionId, { prompt: 'Start' });
      expect(run.status).toBe('pending');
      const stream = coordinator.subscribeRunStream(run.id, 0);
      expect(coordinator.stopRun(run.id)).toEqual({ runId: run.id, status: 'stopping' });
      expect(coordinator.stopRun(run.id)).toEqual({ runId: run.id, status: 'stopping' });
      expect(await Array.fromAsync(stream)).toMatchObject([{ seq: 1, event: {
        type: 'agent_end', status: 'stopped', stopReason: 'user_abort',
      } }]);
      expect(coordinator.stopRun(run.id)).toMatchObject({ alreadyTerminal: true, status: 'stopped' });
      expect(coordinator.activeRunCount).toBe(0);
      expect(coordinator.subscriberCount).toBe(0);
    }));

  it('redacts secrets spanning deltas, flushes before message_end, and replays the same persisted events', () =>
    withRun(async (coordinator, sessionId) => {
      const run = coordinator.startRun(sessionId, { prompt: 'Start' });
      const events = await Array.fromAsync(coordinator.subscribeRunStream(run.id, 0));
      expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
      const deltas = events.flatMap(({ event }) => event.type === 'message_update' ? [event.delta] : []);
      expect(deltas.length).toBeLessThan(20);
      expect(deltas.join('')).toBe('begin [REDACTED] end');
      expect(events.find(({ event }) => event.type === 'message_end')?.event).toMatchObject({
        message: { content: 'begin [REDACTED] end' },
      });
      expect(coordinator.getRunDetail(run.id)).toMatchObject({ run: { finalAnswer: 'begin [REDACTED] end' }, events });
      expect(await Array.fromAsync(coordinator.subscribeRunStream(run.id, 2))).toEqual(events.slice(2));
      expect(coordinator.subscriberCount).toBe(0);
    }));
});
