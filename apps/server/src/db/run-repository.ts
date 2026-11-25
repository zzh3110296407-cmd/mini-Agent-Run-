import { InvestigationRunSchema, RunEventEnvelopeSchema, type AgentEvent, type InvestigationRun } from '@mini-agent-run/shared';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isActiveRun, RunCoordinatorError, type RunStorePort } from '../runtime/ports.js';
import { getSession, nextActivityTime } from './session-repository.js';

export const MAX_RETRIES_PER_ROOT_RUN = 3;

const runFields = `
  id, session_id AS sessionId, retry_of_run_id AS retryOfRunId, prompt,
  status, stop_reason AS stopReason, error_code AS errorCode, error_message AS errorMessage,
  model_provider AS modelProvider, model_id AS modelId, tool_mode AS toolMode,
  step_count AS stepCount, max_steps AS maxSteps, final_answer AS finalAnswer,
  conclusion_json AS conclusion, last_seq AS lastSeq, created_at AS createdAt,
  started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs
`;
type RunRow = Omit<InvestigationRun, 'conclusion'> & { conclusion: string | null };
type InsertRunParams = Parameters<RunStorePort['createRun']>[0] & { id: string; now: string };
type FinishRunParams = {
  runId: string; endedAt: string; status: InvestigationRun['status']; stopReason: InvestigationRun['stopReason'];
  durationMs: number; seq: number; errorCode: string | null; errorMessage: string | null;
  finalAnswer: string | null; conclusion: string | null;
};

function decodeRun(row: RunRow) {
  return InvestigationRunSchema.parse({
    ...row, conclusion: row.conclusion === null ? null : JSON.parse(row.conclusion),
  });
}

export function createSqliteRunStore(db: Database.Database): RunStorePort {
  const selectRun = db.prepare<[string], RunRow>(`SELECT ${runFields} FROM investigation_runs WHERE id = ?`);
  const insertRun = db.prepare<Omit<InsertRunParams, 'retryOfRunId'> & { retryOfRunId: string | null }, RunRow>(`
    INSERT INTO investigation_runs
      (id, session_id, retry_of_run_id, prompt, status, model_provider, model_id, tool_mode, max_steps, created_at)
    VALUES (@id, @sessionId, @retryOfRunId, @prompt, 'pending', @modelProvider, @modelId, @toolMode, @maxSteps, @now)
    RETURNING ${runFields}
  `);
  const touchSession = db.prepare(`
    UPDATE sessions SET updated_at = ${nextActivityTime} WHERE id = @sessionId
  `);
  const countRetryTreeRetries = db.prepare<[string], { retries: number }>(`
    WITH RECURSIVE ancestors(id, parent) AS (
      SELECT id, retry_of_run_id FROM investigation_runs WHERE id = ?
      UNION
      SELECT run.id, run.retry_of_run_id FROM investigation_runs AS run JOIN ancestors ON run.id = ancestors.parent
    ), attempts(id) AS (
      SELECT id FROM ancestors WHERE parent IS NULL
      UNION
      SELECT run.id FROM investigation_runs AS run JOIN attempts ON run.retry_of_run_id = attempts.id
    )
    SELECT count(*) - 1 AS retries FROM attempts
  `);
  const begin = db.prepare(`
    UPDATE investigation_runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'
  `);
  const insertEvent = db.prepare(`
    INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const advance = db.prepare('UPDATE investigation_runs SET last_seq = ?, step_count = ? WHERE id = ?');
  const finish = db.prepare<FinishRunParams, RunRow>(`
    UPDATE investigation_runs
    SET status = @status, stop_reason = @stopReason, error_code = @errorCode, error_message = @errorMessage,
        final_answer = @finalAnswer, conclusion_json = @conclusion, ended_at = @endedAt,
        duration_ms = @durationMs, last_seq = @seq
    WHERE id = @runId AND status IN ('pending', 'running')
    RETURNING ${runFields}
  `);
  const selectEvents = db.prepare<[string, number], { seq: number; timestamp: string; payload: string }>(`
    SELECT seq, created_at AS timestamp, payload_json AS payload
    FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC
  `);
  const priorRuns = db.prepare<[string], RunRow>(`
    SELECT ${runFields} FROM investigation_runs WHERE session_id = ? ORDER BY created_at ASC, rowid ASC
  `);

  function persistEvent(runId: string, seq: number, timestamp: string, event: AgentEvent) {
    const envelope = RunEventEnvelopeSchema.parse({ seq, runId, timestamp, event });
    insertEvent.run(runId, seq, event.type, JSON.stringify(envelope.event), timestamp);
    return envelope;
  }

  const createRun = db.transaction<RunStorePort['createRun']>((input) => {
    if (!getSession(db, input.sessionId)) throw new RunCoordinatorError('SESSION_NOT_FOUND');
    if (input.retryOfRunId !== undefined) {
      const source = selectRun.get(input.retryOfRunId);
      if (!source || source.sessionId !== input.sessionId) throw new RunCoordinatorError('RUN_NOT_FOUND');
      if (isActiveRun(source.status)) throw new RunCoordinatorError('RUN_STILL_ACTIVE');
      if (source.status === 'completed') throw new RunCoordinatorError('RUN_NOT_RETRYABLE');
      if ((countRetryTreeRetries.get(source.id)?.retries ?? 0) >= MAX_RETRIES_PER_ROOT_RUN) {
        throw new RunCoordinatorError('RETRY_LIMIT_EXCEEDED');
      }
    }

    const now = new Date().toISOString();
    const params = { ...input, id: 'run_' + randomUUID(), retryOfRunId: input.retryOfRunId ?? null, now };
    let row: RunRow | undefined;
    try {
      row = insertRun.get(params);
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new RunCoordinatorError('SESSION_HAS_ACTIVE_RUN');
      }
      throw error;
    }
    if (!row) throw new Error('Run insert did not return a row.');
    touchSession.run(params);
    return decodeRun(row);
  });

  const appendEvents = db.transaction<RunStorePort['appendEvents']>((runId, events) => {
    const run = selectRun.get(runId);
    if (!run || !isActiveRun(run.status) || events.length === 0) return [];
    const timestamp = new Date().toISOString();
    let { lastSeq, stepCount } = run;
    const envelopes = events.map((event: AgentEvent) => {
      if (event.type === 'agent_end') throw new Error('Use finishRun to persist agent_end.');
      if (event.type === 'turn_start') stepCount = Math.max(stepCount, event.step);
      return persistEvent(runId, ++lastSeq, timestamp, event);
    });
    advance.run(lastSeq, stepCount, runId);
    return envelopes;
  });

  const finishRun = db.transaction<RunStorePort['finishRun']>((runId, endedAt, event) => {
    const active = selectRun.get(runId);
    if (!active || !isActiveRun(active.status)) return { updated: false };
    const envelope = persistEvent(runId, active.lastSeq + 1, endedAt, event);
    const { status, stopReason, durationMs, error, finalAnswer, conclusion } = event;
    const row = finish.get({
      runId, endedAt, status, stopReason, durationMs, seq: envelope.seq,
      errorCode: error?.code ?? null, errorMessage: error?.message ?? null,
      finalAnswer: finalAnswer ?? null, conclusion: conclusion ? JSON.stringify(conclusion) : null,
    });
    if (!row) throw new Error('Active run disappeared during finalization.');
    touchSession.run({ sessionId: row.sessionId, now: endedAt });
    return { updated: true, run: decodeRun(row), envelope };
  });

  return {
    getSession: (id) => getSession(db, id),
    createRun: createRun.immediate,
    markRunning: (id, startedAt) => begin.run(startedAt, id).changes === 1,
    appendEvents: appendEvents.immediate,
    finishRun: finishRun.immediate,
    getRun: (id) => {
      const row = selectRun.get(id);
      return row ? decodeRun(row) : null;
    },
    listRunEvents: (id, afterSeq = 0) => selectEvents.all(id, afterSeq).map(({ seq, timestamp, payload }) =>
      RunEventEnvelopeSchema.parse({ seq, runId: id, timestamp, event: JSON.parse(payload) })),
    listPriorSessionRuns: (id) => priorRuns.all(id).map(decodeRun),
  };
}
