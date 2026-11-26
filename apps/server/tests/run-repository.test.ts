import { describe, expect, it } from 'vitest';
import { openAppDatabase, recoverStaleRuns } from '../src/db/database.js';
import { createSqliteRunStore } from '../src/db/run-repository.js';
import { createSession, getSessionDetail } from '../src/db/session-repository.js';

const now = '2026-11-25T00:00:00.000Z';
const finish = { type: 'agent_end', status: 'stopped', stopReason: 'user_abort', durationMs: 0 } as const;

function withStore(test: (
  store: ReturnType<typeof createSqliteRunStore>, sessionId: string, recover: () => number,
  db: ReturnType<typeof openAppDatabase>,
) => void) {
  const db = openAppDatabase(':memory:');
  try {
    const session = createSession(db, { targetPath: '/fixture', pathType: 'dir' });
    test(createSqliteRunStore(db), session.id, () => recoverStaleRuns(db, now), db);
  } finally {
    db.close();
  }
}

function input(sessionId: string) {
  return { sessionId, prompt: 'Investigate', modelId: 'fixture', modelProvider: 'fixture', maxSteps: 12, toolMode: 'mock' } as const;
}

describe('M2.3 Run repository', () => {
  it('tracks activity and step count, and commits the final frame exactly once', () => withStore((store, sessionId) => {
    const before = store.getSession(sessionId)?.updatedAt;
    const run = store.createRun(input(sessionId));
    expect(store.getSession(sessionId)?.updatedAt).not.toBe(before);
    expect(() => store.createRun(input(sessionId))).toThrow(expect.objectContaining({ code: 'SESSION_HAS_ACTIVE_RUN' }));
    expect(store.markRunning(run.id, now)).toBe(true);
    expect(store.markRunning(run.id, now)).toBe(false);
    expect(store.appendEvents(run.id, [{ type: 'turn_start', step: 2 }]).map(({ seq }) => seq)).toEqual([1]);
    expect(store.finishRun(run.id, now, finish)).toMatchObject({
      updated: true, run: { lastSeq: 2, status: 'stopped', stepCount: 2 }, envelope: { seq: 2, event: finish },
    });
    expect(store.finishRun(run.id, now, { ...finish, status: 'completed', stopReason: 'completed' })).toEqual({ updated: false });
    expect(store.appendEvents(run.id, [{ type: 'turn_end', step: 2, toolCallCount: 0 }])).toEqual([]);
    expect(store.listRunEvents(run.id, 1).map(({ seq, event }) => [seq, event.type])).toEqual([[2, 'agent_end']]);
  }));

  it('F08_HISTORY_REPLAY_AND_RESUME restores an older conclusion in session detail and run replay without rewriting SQLite', () =>
    withStore((store, sessionId, _recover, db) => {
      const run = store.createRun(input(sessionId));
      store.appendEvents(run.id, [{ type: 'turn_start', step: 62 }]);
      const marker = String.fromCharCode(96).repeat(3);
      const finalAnswer = 'The tool returned a different total.';
      const conclusion = {
        summary: 'The supplied quantity was wrong.', rootCauseStep: 130,
        threeStateAssessment: { hasToolError: true, taskOutcome: 'failed' },
        evidence: [{ kind: 'file_step', file: 'trace.json', step: 130, label: 'Tool input' }],
        recommendations: ['Recalculate the quantity.'],
      };
      const original = [finalAnswer, '', marker + 'investigation-conclusion', JSON.stringify({
        ...conclusion, threeStateAssessment: { ...conclusion.threeStateAssessment, terminationReason: null },
      }), marker].join('\n');
      store.finishRun(run.id, now, {
        type: 'agent_end', status: 'completed', stopReason: 'completed', durationMs: 323330, finalAnswer: original,
      });

      const restored = { status: 'completed', finalAnswer, conclusion };
      expect(store.getRun(run.id)).toMatchObject(restored);
      expect(getSessionDetail(db, sessionId)?.runs).toMatchObject([{ id: run.id, stepCount: 62, ...restored }]);
      expect(store.listRunEvents(run.id, 1)).toMatchObject([{ seq: 2, event: { type: 'agent_end', ...restored } }]);
      expect(db.prepare('SELECT final_answer, conclusion_json FROM investigation_runs WHERE id = ?').get(run.id))
        .toEqual({ final_answer: original, conclusion_json: null });

      const stopped = store.createRun(input(sessionId));
      store.finishRun(stopped.id, now, { ...finish, finalAnswer: original });
      expect(store.getRun(stopped.id)).toMatchObject({ status: 'stopped', finalAnswer: original, conclusion: null });
      expect(store.listRunEvents(stopped.id).at(-1)?.event).not.toHaveProperty('conclusion');
    }));

  it('allocates three retries across branches and recovers through the same terminal transaction', () => withStore((store, sessionId, recover) => {
    const root = store.createRun(input(sessionId));
    expect(() => store.createRun({ ...input(sessionId), retryOfRunId: root.id }))
      .toThrow(expect.objectContaining({ code: 'RUN_STILL_ACTIVE' }));
    store.finishRun(root.id, now, finish);
    const a = store.createRun({ ...input(sessionId), retryOfRunId: root.id });
    store.finishRun(a.id, now, finish);
    const b = store.createRun({ ...input(sessionId), retryOfRunId: a.id });
    store.finishRun(b.id, now, finish);
    const c = store.createRun({ ...input(sessionId), retryOfRunId: root.id });
    store.appendEvents(c.id, [{ type: 'turn_start', step: 1 }]);
    expect(recover()).toBe(1);
    expect(recover()).toBe(0);
    expect(store.listRunEvents(c.id).map(({ event }) => event.type)).toEqual(['turn_start', 'agent_end']);
    expect(store.getRun(c.id)).toMatchObject({ status: 'failed', stopReason: 'server_restarted', lastSeq: 2 });
    expect(store.listPriorSessionRuns(sessionId).map(({ id }) => id)).toEqual([root.id, a.id, b.id, c.id]);
    expect(() => store.createRun({ ...input(sessionId), retryOfRunId: b.id }))
      .toThrow(expect.objectContaining({ code: 'RETRY_LIMIT_EXCEEDED' }));
  }));
});
