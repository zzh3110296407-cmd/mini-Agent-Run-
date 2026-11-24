import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GetTrajectoryRunSchema,
  ListTrajectoryRunsSchema,
  MAX_TRAJECTORY_RUN_ID_LENGTH,
  ReadTrajectoryLogSchema,
  SearchTrajectoryLogsSchema,
  type TrajectoryLogHit,
  type TrajectoryStep,
  type TrajectorySummary,
  type TrajectoryTools,
} from '@mini-agent-run/shared';
import Database from 'better-sqlite3';
import { z } from 'zod';

// The import contract lists only evidence fields. Unknown properties are stripped.
const EvidenceSchema = z.object({
  metadata: z.object({
    task_description: z.string(),
    reward: z.union([z.literal(0), z.literal(1)]),
    extra: z.object({
      pair_id: z.string().min(1).max(MAX_TRAJECTORY_RUN_ID_LENGTH),
      source_benchmark: z.enum(['tau2bench', 'swebenchpro']),
    }),
  }),
  messages: z.array(z.object({
    step: z.number().int().nonnegative(),
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    name: z.string().optional(),
    content: z.string(),
  })).min(1),
});

const schema = `
  CREATE TABLE IF NOT EXISTS trajerrbench_runs (
    run_id TEXT PRIMARY KEY,
    source_benchmark TEXT NOT NULL,
    task_description TEXT NOT NULL,
    reward INTEGER NOT NULL,
    step_count INTEGER NOT NULL,
    log_bytes INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trajerrbench_steps (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES trajerrbench_runs(run_id),
    step INTEGER NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    content_length INTEGER NOT NULL,
    UNIQUE (run_id, step)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS trajerrbench_fts USING fts5(content, tokenize='trigram');
`;

function readEvidence(sourceDir: string, name: string) {
  try {
    const evidence = EvidenceSchema.parse(JSON.parse(readFileSync(join(sourceDir, name), 'utf8')));
    if (evidence.messages.some((message, index) => message.step !== index)) {
      throw new Error('Unexpected step sequence.');
    }
    return evidence;
  } catch {
    throw new Error('Invalid TrajErrBench file: ' + name);
  }
}

export function importTrajErrBench(sourceDir: string, databasePath: string) {
  const files = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error('The TrajErrBench train directory contains no JSON records.');

  const evidence = files.map((file) => readEvidence(sourceDir, file));
  const ids = new Set(evidence.map((record) => record.metadata.extra.pair_id));
  if (ids.size !== evidence.length) throw new Error('Duplicate TrajErrBench run IDs.');

  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  let stepCount = 0;
  try {
    database.transaction(() => {
      database.exec(schema);
      // This transaction replaces only the derived TrajErrBench snapshot.
      database.exec('DELETE FROM trajerrbench_fts; DELETE FROM trajerrbench_steps; DELETE FROM trajerrbench_runs;');
      const insertRun = database.prepare('INSERT INTO trajerrbench_runs VALUES (?, ?, ?, ?, ?, ?)');
      const insertStep = database.prepare(`
        INSERT INTO trajerrbench_steps(run_id, step, role, name, content, content_length)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const indexStep = database.prepare('INSERT INTO trajerrbench_fts(rowid, content) VALUES (?, ?)');

      for (const { metadata, messages } of evidence) {
        const { pair_id: runId, source_benchmark: source } = metadata.extra;
        const logBytes = messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0);
        insertRun.run(runId, source, metadata.task_description, metadata.reward, messages.length, logBytes);
        for (const { step, role, name, content } of messages) {
          const { lastInsertRowid } = insertStep.run(runId, step, role, name ?? role, content, content.length);
          indexStep.run(lastInsertRowid, content);
          stepCount++;
        }
      }
    }).immediate();
  } finally {
    database.close();
  }
  return { runCount: evidence.length, stepCount };
}

export class TrajectoryDatasetUnavailable extends Error {
  constructor() {
    super('Import TrajErrBench with npm run cli -- trajerrbench-import.');
  }
}

function withEvidenceDatabase<T>(databasePath: string, query: (database: Database.Database) => T): T {
  if (!existsSync(databasePath)) throw new TrajectoryDatasetUnavailable();
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.transaction(() => {
      const imported = database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trajerrbench_runs'",
      ).get();
      if (!imported) throw new TrajectoryDatasetUnavailable();
      return query(database);
    })();
  } finally {
    database.close();
  }
}

const runColumns = `run_id AS runId, source_benchmark AS sourceBenchmark, task_description AS taskDescription,
  reward, step_count AS stepCount, log_bytes AS logBytes`;
const stepColumns = 'step, role, name, content_length AS contentLength';
const chunkLength = 8192;

function splitsSurrogatePair(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

export function createTrajectoryTools(databasePath: string): TrajectoryTools {
  return {
    listRuns(input) {
      const { limit } = ListTrajectoryRunsSchema.parse(input);
      return withEvidenceDatabase(databasePath, (database) =>
        database.prepare<[number], TrajectorySummary>(`
          SELECT ${runColumns} FROM trajerrbench_runs ORDER BY log_bytes DESC, run_id LIMIT ?
        `).all(limit),
      );
    },
    getRunDetail(input) {
      const { runId, after, limit } = GetTrajectoryRunSchema.parse(input);
      return withEvidenceDatabase(databasePath, (database) => {
        const run = database.prepare<[string], TrajectorySummary>(
          'SELECT ' + runColumns + ' FROM trajerrbench_runs WHERE run_id = ?',
        ).get(runId);
        if (!run) return null;
        const steps = database.prepare<[string, number, number], TrajectoryStep>(`
          SELECT ${stepColumns} FROM trajerrbench_steps WHERE run_id = ? AND step > ? ORDER BY step LIMIT ?
        `).all(runId, after ?? -1, limit + 1);
        const hasMore = steps.length > limit;
        if (hasMore) steps.pop();
        return { run, steps, nextAfter: hasMore ? steps.at(-1)?.step ?? null : null };
      });
    },
    searchRuntimeLogs(input) {
      const { query, runId, limit } = SearchTrajectoryLogsSchema.parse(input);
      const useIndex = [...query].length >= 3;
      const table = useIndex
        ? 'trajerrbench_fts JOIN trajerrbench_steps AS s ON s.id = trajerrbench_fts.rowid'
        : 'trajerrbench_steps AS s';
      const match = useIndex ? 'trajerrbench_fts MATCH @phrase' : 'instr(lower(s.content), lower(@query)) > 0';
      const phrase = '"' + query.replaceAll('"', '""') + '"';
      return withEvidenceDatabase(databasePath, (database) =>
        database.prepare<{ query: string; phrase: string; runId: string | null; limit: number }, TrajectoryLogHit>(`
          SELECT s.run_id AS runId, s.step, s.role, s.name,
            substr(s.content, max(1, instr(lower(s.content), lower(@query)) - 60), 320) AS excerpt
          FROM ${table}
          WHERE (${match}) AND (@runId IS NULL OR s.run_id = @runId)
          ORDER BY s.run_id, s.step LIMIT @limit
        `).all({ query, phrase, runId: runId ?? null, limit }),
      );
    },
    readRuntimeLog(input) {
      const { runId, step, offset } = ReadTrajectoryLogSchema.parse(input);
      return withEvidenceDatabase(databasePath, (database) => {
        const log = database.prepare<[string, number], TrajectoryStep & { content: string }>(`
          SELECT ${stepColumns}, content FROM trajerrbench_steps WHERE run_id = ? AND step = ?
        `).get(runId, step);
        if (!log || offset > log.contentLength) return null;
        const { content, ...details } = log;
        if (splitsSurrogatePair(content, offset)) return null;
        let end = Math.min(offset + chunkLength, content.length);
        if (splitsSurrogatePair(content, end)) end--;
        return {
          ...details,
          runId,
          offset,
          text: content.slice(offset, end),
          nextOffset: end < content.length ? end : null,
        };
      });
    },
  };
}
