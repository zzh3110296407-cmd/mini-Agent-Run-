import Database from 'better-sqlite3';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'manual')),
  target_path TEXT NOT NULL,
  path_type TEXT NOT NULL CHECK (path_type IN ('file', 'dir')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS investigation_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  retry_of_run_id TEXT REFERENCES investigation_runs(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'stopped', 'failed')),
  stop_reason TEXT CHECK (stop_reason IN ('completed', 'user_abort', 'max_steps', 'error', 'server_restarted')),
  error_code TEXT,
  error_message TEXT,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tool_mode TEXT NOT NULL CHECK (tool_mode IN ('mock', 'live')),
  step_count INTEGER NOT NULL DEFAULT 0,
  max_steps INTEGER NOT NULL DEFAULT 12,
  final_answer TEXT,
  conclusion_json TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  UNIQUE (id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_session_created ON investigation_runs(session_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_active_per_session
  ON investigation_runs(session_id) WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES investigation_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  source_tool TEXT NOT NULL,
  title TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('text/plain', 'application/json', 'application/x-ndjson')),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  content TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, session_id) REFERENCES investigation_runs(id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at ASC);
`;

const ownerLocks = new Set<string>();
const busyMessage = 'Database is already managed by another running server instance.';

export interface DatabaseOwnerLock {
  readonly dbPath: string;
  release(): void;
}

function canonicalDatabasePath(dbPath: string) {
  const absolute = resolve(dbPath);
  const name = basename(absolute);
  if (process.platform === 'win32' && /:|[. ]$/.test(name)) {
    throw new Error('The database filename has ambiguous Windows path syntax.');
  }
  mkdirSync(dirname(absolute), { recursive: true });
  if (!lstatSync(absolute, { throwIfNoEntry: false })) {
    return join(realpathSync.native(dirname(absolute)), name);
  }

  const canonical = realpathSync.native(absolute);
  const metadata = statSync(canonical);
  if (!metadata.isFile()) throw new Error('The database path must identify a regular file.');
  // A hard link cannot be reduced to one filename for the WAL and owner lock.
  if (metadata.nlink !== 1) throw new Error('Database files with hard links are unsupported.');
  return canonical;
}

export function openAppDatabase(dbPath: string): Database.Database {
  const filename = dbPath === ':memory:' ? dbPath : canonicalDatabasePath(dbPath);
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (filename !== ':memory:') db.pragma('journal_mode = WAL');
    db.transaction(() => db.exec(schema))();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function recoverStaleRuns(db: Database.Database, now = new Date().toISOString()): number {
  const active = db.prepare<[], { id: string; started_at: string | null }>(`
    SELECT id, started_at FROM investigation_runs WHERE status IN ('pending', 'running')
  `);
  const failRun = db.prepare(`
    UPDATE investigation_runs
    SET status = 'failed', stop_reason = 'server_restarted', error_code = 'SERVER_RESTARTED',
        error_message = 'Run interrupted because the server restarted.', ended_at = ?, duration_ms = ?
    WHERE id = ?
  `);
  return db.transaction(() => {
    const runs = active.all();
    const endedAt = Date.parse(now);
    for (const run of runs) {
      const startedAt = run.started_at === null ? Number.NaN : Date.parse(run.started_at);
      const duration = Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : 0;
      failRun.run(now, duration, run.id);
    }
    return runs.length;
  }).immediate();
}

export function acquireDatabaseOwnerLock(dbPath: string): DatabaseOwnerLock {
  if (dbPath === ':memory:') return { dbPath, release() {} };

  const canonical = canonicalDatabasePath(dbPath);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  if (ownerLocks.has(key)) throw new Error(busyMessage);
  const lockPath = canonical + '.lock';
  const metadata = lstatSync(lockPath, { throwIfNoEntry: false });
  if (metadata && (!metadata.isFile() || metadata.nlink !== 1)) {
    throw new Error('The database owner lock must be a regular file without aliases.');
  }
  const lock = new Database(lockPath, { timeout: 0 });
  try {
    lock.pragma('busy_timeout = 0');
    lock.pragma('journal_mode = DELETE');
    lock.pragma('locking_mode = EXCLUSIVE');
    lock.transaction(() => {
      lock.exec('CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER PRIMARY KEY CHECK (id = 1))');
      lock.exec('INSERT OR REPLACE INTO instance_lock (id) VALUES (1)');
    }).exclusive();
  } catch (error) {
    lock.close();
    if (error instanceof Database.SqliteError && /^(?:SQLITE_BUSY|SQLITE_LOCKED)/.test(error.code)) {
      throw new Error(busyMessage, { cause: error });
    }
    throw error;
  }

  ownerLocks.add(key);
  return {
    dbPath: canonical,
    release() {
      if (!lock.open) return;
      lock.close();
      ownerLocks.delete(key);
    },
  };
}
