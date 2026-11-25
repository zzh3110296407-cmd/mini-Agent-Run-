import {
  SessionDetailSchema, SessionListItemSchema, SessionSchema,
  type InvestigationRun, type Session,
} from '@mini-agent-run/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

const sessionFields = `
  id, title, title_source AS titleSource, target_path AS targetPath, path_type AS pathType,
  created_at AS createdAt, updated_at AS updatedAt
`;

// Allocate activity time within each write so creates and renames follow the latest stored activity.
const nextActivityTime = `
  max(@now, coalesce((
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(updated_at), '+0.001 seconds') FROM sessions
  ), @now))
`;

type RunRow = Omit<InvestigationRun, 'conclusion'> & { conclusion: string | null };

export function deriveAutoSessionTitle(realPath: string) {
  return basename(realPath).trim() || realPath;
}

export function createSession(
  db: Database.Database, { targetPath, pathType, title }: Pick<Session, 'targetPath' | 'pathType'> & { title?: string },
) {
  const row = db.prepare(`
    INSERT INTO sessions (id, title, title_source, target_path, path_type, created_at, updated_at)
    VALUES (@id, @title, @titleSource, @targetPath, @pathType, @now, ${nextActivityTime})
    RETURNING ${sessionFields}
  `).get({
    id: 'ses_' + randomUUID(), title: title ?? deriveAutoSessionTitle(targetPath),
    titleSource: title === undefined ? 'auto' : 'manual', targetPath, pathType, now: new Date().toISOString(),
  });
  return SessionSchema.parse(row);
}

export function listSessions(db: Database.Database) {
  const rows = db.prepare<[], Session & { runCount: number; hasActiveRun: 0 | 1 }>(`
    SELECT ${sessionFields}, coalesce(stats.run_count, 0) AS runCount,
           coalesce(stats.has_active_run, 0) AS hasActiveRun
    FROM sessions
    LEFT JOIN (
      SELECT session_id, count(*) AS run_count, max(status IN ('pending', 'running')) AS has_active_run
      FROM investigation_runs
      GROUP BY session_id
    ) AS stats ON stats.session_id = sessions.id
    ORDER BY updated_at DESC, sessions.rowid DESC
  `).all();
  return rows.map((row) => SessionListItemSchema.parse({ ...row, hasActiveRun: row.hasActiveRun === 1 }));
}

export function getSession(db: Database.Database, sessionId: string): Session | null {
  const row = db.prepare(`SELECT ${sessionFields} FROM sessions WHERE id = ?`).get(sessionId);
  return row === undefined ? null : SessionSchema.parse(row);
}

export function getSessionDetail(db: Database.Database, sessionId: string) {
  return db.transaction(() => {
    const session = getSession(db, sessionId);
    if (!session) return null;
    const runs = db.prepare<[string], RunRow>(`
      SELECT id, session_id AS sessionId, retry_of_run_id AS retryOfRunId, prompt,
             status, stop_reason AS stopReason, error_code AS errorCode, error_message AS errorMessage,
             model_provider AS modelProvider, model_id AS modelId, tool_mode AS toolMode,
             step_count AS stepCount, max_steps AS maxSteps, final_answer AS finalAnswer,
             conclusion_json AS conclusion, last_seq AS lastSeq, created_at AS createdAt,
             started_at AS startedAt, ended_at AS endedAt, duration_ms AS durationMs
      FROM investigation_runs WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(sessionId).map((run) => ({
      ...run, conclusion: run.conclusion === null ? null : JSON.parse(run.conclusion),
    }));
    const hasActiveRun = runs.some((run) => run.status === 'pending' || run.status === 'running');
    return SessionDetailSchema.parse({ session, hasActiveRun, runs });
  })();
}

export function renameSession(db: Database.Database, sessionId: string, title: string): Session | null {
  const row = db.prepare(`
    UPDATE sessions
    SET title = @title, title_source = 'manual', updated_at = ${nextActivityTime}
    WHERE id = @sessionId
    RETURNING ${sessionFields}
  `).get({ title, now: new Date().toISOString(), sessionId });
  return row === undefined ? null : SessionSchema.parse(row);
}

export function deleteSession(db: Database.Database, sessionId: string) {
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) return 'not_found';
    const active = db.prepare(`
      SELECT 1 FROM investigation_runs WHERE session_id = ? AND status IN ('pending', 'running') LIMIT 1
    `).get(sessionId);
    if (active) return 'active_run';
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return 'deleted';
  }).immediate();
}
