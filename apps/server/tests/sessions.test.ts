import {
  COMPUTER_ROOT_PATH, SessionDetailSchema, SessionListItemSchema, SessionSchema, TextSliceResponseSchema,
  type LogLevel, type RunStatus,
} from '@mini-agent-run/shared';
import type Database from 'better-sqlite3';
import fc from 'fast-check';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { acquireDatabaseOwnerLock, openAppDatabase, recoverStaleRuns } from '../src/db/database.js';
import { sliceTextContent } from '../src/fs/file-slice.js';
import { readSafeSessionFile } from '../src/fs/path-sandbox.js';
import { createServerTraceWorkspace } from '../src/fs/trace-workspace.js';
import { startServer } from '../src/start-server.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync),
  };
});

const createdAt = '2026-11-25T09:00:00.000Z';
const later = '2026-11-25T09:00:00.123Z';
const sessionsUrl = '/api/sessions';
const sampleText = 'INFO opening\r\nWARN needle\r\nERROR interruption\nWARN other\r\nWARN Needle again\n';

function seedSession(db: Database.Database, id: string, targetPath = '/fixture') {
  db.prepare('INSERT INTO sessions (id, title, target_path, path_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'Fixture', targetPath, 'dir', createdAt, createdAt);
}

function seedRun(
  db: Database.Database,
  id: string,
  sessionId: string,
  status: RunStatus,
  options: { startedAt?: string; conclusion?: string } = {},
) {
  db.prepare(`
    INSERT INTO investigation_runs (id, session_id, prompt, status, model_provider, model_id,
      tool_mode, created_at, started_at, conclusion_json)
    VALUES (?, ?, 'Check fixture', ?, 'fixture', 'test', 'mock', ?, ?, ?)
  `).run(id, sessionId, status, createdAt, options.startedAt ?? null, options.conclusion ?? null);
}

function seedArtifact(db: Database.Database, runId: string, sessionId: string) {
  db.prepare(`
    INSERT INTO artifacts (id, run_id, session_id, tool_call_id, source_tool, title, content_type,
      byte_size, line_count, content, summary_json, created_at)
    VALUES ('art_a', ?, ?, 'tc_a', 'fixture', 'Text', 'text/plain', 1, 1, 'x', '{}', ?)
  `).run(runId, sessionId, createdAt);
}

function runStatus(db: Database.Database, runId: string) {
  return db.prepare<[string], { status: RunStatus }>('SELECT status FROM investigation_runs WHERE id = ?').get(runId)?.status;
}

function makeDirectoryLink(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('[F02_SESSION_WORKSPACE] persistent sessions and scoped file slices', () => {
  let fixture: string;
  let dbPath: string;
  let root: string;
  let directoryA: string;
  let directoryB: string;
  let sample: string;
  let apps: ReturnType<typeof buildApp>[];

  beforeEach(() => {
    const parent = fs.realpathSync.native(tmpdir());
    fixture = fs.mkdtempSync(join(parent, 'm13-session-'));
    if (dirname(fixture) !== parent) throw new Error('Unexpected sessions fixture directory.');
    dbPath = join(fixture, 'run.db');
    root = join(fixture, 'root');
    directoryA = join(root, 'trace-a');
    directoryB = join(root, 'trace-b');
    for (const directory of [root, directoryA, directoryB]) fs.mkdirSync(directory);
    sample = join(directoryA, 'sample.LOG');
    fs.writeFileSync(sample, sampleText);
    apps = [];
  });

  afterEach(async () => {
    vi.mocked(fs.openSync).mockReset();
    vi.mocked(fs.readSync).mockReset();
    vi.mocked(fs.closeSync).mockReset();
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  function openTestApp(options: BuildAppOptions = {}) {
    const app = buildApp({ dbPath, allowedTraceRoots: [root], baseDir: fixture, ...options });
    apps.push(app);
    return app;
  }

  async function create(app: ReturnType<typeof buildApp>, targetPath: string, title?: string) {
    const response = await app.inject({ method: 'POST', url: sessionsUrl, payload: { targetPath, title } });
    expect(response.statusCode, response.body).toBe(201);
    return SessionSchema.parse(response.json());
  }

  function expectError(response: { statusCode: number; json(): unknown }, statusCode: number, code: string) {
    expect(response.statusCode, JSON.stringify(response.json())).toBe(statusCode);
    expect(response.json()).toEqual({ error: { code, message: expect.any(String) } });
  }

  function fileSlice(id: string, query?: Record<string, string>): string {
    const route = sessionsUrl + '/' + id + '/file-slice';
    return query === undefined ? route : route + '?' + new URLSearchParams(query).toString();
  }

  it('rejects the virtual computer target and confines traces to the session in default mode', async () => {
    const app = openTestApp({ allowedTraceRoots: undefined });
    expectError(await app.inject({ method: 'POST', url: sessionsUrl, payload: { targetPath: COMPUTER_ROOT_PATH } }),
      400, 'INVALID_PATH');
    const session = await create(app, directoryA);
    const other = join(directoryB, 'outside.log');
    fs.writeFileSync(other, 'outside the session');
    expect((await app.inject(fileSlice(session.id, { file: 'sample.LOG' }))).statusCode).toBe(200);
    expectError(await app.inject(fileSlice(session.id, { file: other })), 403, 'PATH_OUTSIDE_SESSION_SCOPE');
    const workspace = createServerTraceWorkspace(session, { baseDir: fixture });
    expect(workspace.readFile('sample.LOG', ['*']).content).toBe(sampleText);
    expect(() => workspace.readFile(other, ['*']))
      .toThrow(expect.objectContaining({ code: 'PATH_OUTSIDE_SESSION_SCOPE' }));
  });

  it('enforces four-table, WAL, unique, and composite foreign-key constraints in SQLite', () => {
    const db = openAppDatabase(dbPath);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .pluck().all()).toEqual(['artifacts', 'investigation_runs', 'run_events', 'sessions']);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
        .pluck().all()).toEqual([
        'idx_artifacts_run', 'idx_run_events_run_seq', 'idx_runs_one_active_per_session', 'idx_runs_session_created',
        'idx_sessions_updated_at',
      ]);
      seedSession(db, 'ses_a');
      seedSession(db, 'ses_b');
      seedRun(db, 'run_previous', 'ses_a', 'completed');
      seedRun(db, 'run_a', 'ses_a', 'running');
      seedRun(db, 'run_b', 'ses_b', 'running');
      expect(() => seedRun(db, 'run_conflict', 'ses_a', 'pending')).toThrow(/UNIQUE/);
      expect(() => seedArtifact(db, 'run_a', 'ses_b')).toThrow(/FOREIGN KEY/);
      seedArtifact(db, 'run_a', 'ses_a');
      const event = db.prepare(`
        INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at)
        VALUES ('run_a', ?, 'turn_start', '{}', ?)
      `);
      expect(() => event.run(0, createdAt)).toThrow(/CHECK/);
      event.run(1, createdAt);
      expect(() => event.run(1, createdAt)).toThrow(/UNIQUE/);
      db.prepare("DELETE FROM sessions WHERE id = 'ses_a'").run();
      expect(db.prepare('SELECT COUNT(*) FROM artifacts').pluck().get()).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM run_events').pluck().get()).toBe(0);
      expect(db.prepare('SELECT id FROM investigation_runs').pluck().all()).toEqual(['run_b']);
    } finally {
      db.close();
    }
  });

  it('leaves active runs intact on ordinary open and recovers only active runs explicitly', () => {
    const seed = openAppDatabase(dbPath);
    try {
      for (const id of ['ses_a', 'ses_b', 'ses_c']) seedSession(seed, id);
      seedRun(seed, 'run_running', 'ses_a', 'running', { startedAt: createdAt });
      seedRun(seed, 'run_pending', 'ses_b', 'pending');
      seedRun(seed, 'run_done', 'ses_c', 'completed');
    } finally {
      seed.close();
    }
    const db = openAppDatabase(dbPath);
    try {
      expect(runStatus(db, 'run_running')).toBe('running');
      expect(runStatus(db, 'run_pending')).toBe('pending');
      expect(recoverStaleRuns(db, later)).toBe(2);
      expect(recoverStaleRuns(db, later)).toBe(0);
      expect(db.prepare('SELECT status, stop_reason, error_code, ended_at, duration_ms FROM investigation_runs WHERE id = ?')
        .get('run_running')).toEqual({
        status: 'failed', stop_reason: 'server_restarted', error_code: 'SERVER_RESTARTED',
        ended_at: later, duration_ms: 123,
      });
      expect(db.prepare('SELECT duration_ms FROM investigation_runs WHERE id = ?').pluck().get('run_pending')).toBe(0);
      expect(runStatus(db, 'run_done')).toBe('completed');
      seedRun(db, 'run_new', 'ses_a', 'pending');
    } finally {
      db.close();
    }
  });

  it('shares an owner lock across a directory alias and refuses hard-linked database files', () => {
    const directory = join(fixture, 'real-db');
    fs.mkdirSync(directory);
    const canonical = join(directory, 'run.db');
    const alias = join(fixture, 'alias');
    makeDirectoryLink(directory, alias);
    const owner = acquireDatabaseOwnerLock(canonical);
    try {
      expect(() => acquireDatabaseOwnerLock(join(alias, 'run.db'))).toThrow(/already managed/);
      openAppDatabase(canonical).close();
    } finally {
      owner.release();
      owner.release();
    }
    const acquiredViaAlias = acquireDatabaseOwnerLock(join(alias, 'run.db'));
    acquiredViaAlias.release();
    const hardLink = join(directory, 'alternate.db');
    fs.linkSync(canonical, hardLink);
    expect(() => acquireDatabaseOwnerLock(hardLink)).toThrow(/hard links/);
    expect(() => acquireDatabaseOwnerLock(canonical)).toThrow(/hard links/);
    if (process.platform === 'win32') {
      expect(() => acquireDatabaseOwnerLock(join(directory, 'new.db.'))).toThrow(/ambiguous Windows path/);
    }
  });

  it('keeps all runs intact on listen or owner conflicts and recovers them on takeover', async () => {
    const first = await startServer({ dbPath, port: 0 });
    const other = join(fixture, 'other.db');
    const diagnostics = openAppDatabase(dbPath);
    const otherDb = openAppDatabase(other);
    try {
      seedSession(diagnostics, 'ses_a');
      seedSession(diagnostics, 'ses_b');
      seedRun(diagnostics, 'run_a', 'ses_a', 'running', { startedAt: createdAt });
      seedRun(diagnostics, 'run_b', 'ses_b', 'pending');
      seedSession(otherDb, 'ses_c');
      seedRun(otherDb, 'run_c', 'ses_c', 'running');

      const ordinaryApp = buildApp({ dbPath });
      try {
        expect((await ordinaryApp.inject('/api/health')).statusCode).toBe(200);
        expect(runStatus(diagnostics, 'run_a')).toBe('running');
      } finally {
        await ordinaryApp.close();
      }

      await expect(startServer({ dbPath, port: 0 })).rejects.toThrow(/already managed/);
      await expect(startServer({ dbPath: other, port: Number(new URL(first.address).port) }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
      const released = acquireDatabaseOwnerLock(other);
      released.release();
      expect(runStatus(otherDb, 'run_c')).toBe('running');

      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { startServer } from './apps/server/src/start-server.ts';
        try {
          const { app } = await startServer({ dbPath: process.argv[1], port: 0 });
          await app.close();
        } catch (error) {
          console.error(error.message);
          process.exitCode = 1;
        }
      `, dbPath], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Database is already managed');
      expect(runStatus(diagnostics, 'run_a')).toBe('running');
      expect(runStatus(diagnostics, 'run_b')).toBe('pending');
    } finally {
      otherDb.close();
      diagnostics.close();
      await first.app.close();
    }

    const takeover = await startServer({ dbPath, port: 0 });
    const reopened = openAppDatabase(dbPath);
    try {
      expect(reopened.prepare('SELECT id FROM sessions ORDER BY id').pluck().all()).toEqual(['ses_a', 'ses_b']);
      expect(reopened.prepare('SELECT status, stop_reason FROM investigation_runs ORDER BY id').all()).toEqual([
        { status: 'failed', stop_reason: 'server_restarted' }, { status: 'failed', stop_reason: 'server_restarted' },
      ]);
      expect(() => seedRun(reopened, 'run_new', 'ses_a', 'running')).not.toThrow();
    } finally {
      reopened.close();
      await takeover.app.close();
    }
  }, 12000);

  it('releases the owner lock when the database cannot be opened as an application', async () => {
    fs.writeFileSync(dbPath, 'not a database '.repeat(30));
    await expect(startServer({ dbPath, port: 0 })).rejects.toMatchObject({ code: 'SQLITE_NOTADB' });
    const available = acquireDatabaseOwnerLock(dbPath);
    available.release();
  });

  it('binds canonical directory and file paths, validates input, and handles malformed JSON', async () => {
    const app = openTestApp();
    expect(await create(app, 'root/trace-a')).toMatchObject({
      targetPath: directoryA, pathType: 'dir', title: 'trace-a', titleSource: 'auto',
    });
    expect(await create(app, sample, ' Operator title ')).toMatchObject({
      targetPath: sample, pathType: 'file', title: 'Operator title', titleSource: 'manual',
    });
    const json = join(directoryA, 'trace.json');
    fs.writeFileSync(json, '{}');
    expect(await create(app, json)).toMatchObject({ pathType: 'file', title: 'trace.json', titleSource: 'auto' });

    const executable = join(directoryA, 'trace.exe');
    const sensitive = join(directoryA, '.env');
    const outside = join(fixture, 'outside.json');
    for (const file of [executable, sensitive, outside]) fs.writeFileSync(file, 'fixture');
    for (const { payload, status, code } of [
      { payload: { targetPath: executable }, status: 400, code: 'UNSUPPORTED_TRACE_FILE' },
      { payload: { targetPath: sensitive }, status: 403, code: 'PATH_FORBIDDEN' },
      { payload: { targetPath: outside }, status: 403, code: 'PATH_OUTSIDE_ALLOWED_ROOTS' },
      { payload: { targetPath: join(directoryA, 'missing.json') }, status: 404, code: 'PATH_NOT_FOUND' },
      { payload: { targetPath: ' ' }, status: 400, code: 'INVALID_REQUEST' },
      { payload: {}, status: 400, code: 'INVALID_REQUEST' },
    ]) {
      expectError(await app.inject({ method: 'POST', url: sessionsUrl, payload }), status, code);
    }
    expectError(await app.inject({
      method: 'POST', url: sessionsUrl, headers: { 'content-type': 'application/json' }, payload: '{',
    }), 400, 'INVALID_REQUEST');
  });

  it('renames and sorts sessions, aggregates runs, and restores historical conclusions', async () => {
    const app = openTestApp();
    const first = await create(app, directoryA);
    const second = await create(app, directoryB);
    const oldUpdatedAt = new Date(Date.parse(second.updatedAt) - 60_000).toISOString();
    const conclusion = { summary: 'Prior result', evidence: [], recommendations: ['Check original'] };
    const db = openAppDatabase(dbPath);
    try {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(oldUpdatedAt, first.id);
      seedRun(db, 'run_old', first.id, 'completed', { conclusion: JSON.stringify(conclusion) });
      seedRun(db, 'run_current', first.id, 'pending');
    } finally {
      db.close();
    }
    const getList = async () => {
      const response = await app.inject(sessionsUrl);
      expect(response.statusCode).toBe(200);
      return SessionListItemSchema.array().parse(response.json().sessions);
    };
    expect((await getList()).map(({ id }) => id)).toEqual([second.id, first.id]);
    const renamed = await app.inject({
      method: 'PATCH', url: sessionsUrl + '/' + first.id, payload: { title: ' Renamed ' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const session = SessionSchema.parse(renamed.json());
    expect(session).toMatchObject({ id: first.id, title: 'Renamed', titleSource: 'manual' });
    expect(Date.parse(session.updatedAt)).toBeGreaterThan(Date.parse(second.updatedAt));
    expect(await getList()).toMatchObject([
      { id: first.id, runCount: 2, hasActiveRun: true }, { id: second.id, runCount: 0, hasActiveRun: false },
    ]);
    const detail = await app.inject(sessionsUrl + '/' + first.id);
    expect(detail.statusCode).toBe(200);
    expect(SessionDetailSchema.parse(detail.json())).toMatchObject({
      session, hasActiveRun: true,
      runs: [{ id: 'run_old', conclusion }, { id: 'run_current', conclusion: null }],
    });
    expectError(await app.inject({ method: 'PATCH', url: sessionsUrl + '/' + first.id, payload: { title: ' ' } }),
      400, 'INVALID_REQUEST');
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const body = method === 'PATCH' ? { payload: { title: 'Title' } } : {};
      expectError(await app.inject({ method, url: sessionsUrl + '/invalid', ...body }), 400, 'INVALID_REQUEST');
      expectError(await app.inject({ method, url: sessionsUrl + '/ses_missing', ...body }), 404, 'SESSION_NOT_FOUND');
    }
  });

  it('orders alternating creates and renames within the same millisecond', async () => {
    const app = openTestApp();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(createdAt));
    try {
      const first = await create(app, directoryA, 'A');
      const renameFirst = async (title: string) => {
        const response = await app.inject({
          method: 'PATCH', url: sessionsUrl + '/' + first.id, payload: { title },
        });
        expect(response.statusCode, response.body).toBe(200);
        return SessionSchema.parse(response.json());
      };
      const listIds = async () => {
        const response = await app.inject(sessionsUrl);
        expect(response.statusCode, response.body).toBe(200);
        return SessionListItemSchema.array().parse(response.json().sessions).map(({ id }) => id);
      };

      const firstRename = await renameFirst('A-1');
      const second = await create(app, directoryB, 'B');
      expect(second.createdAt).toBe(createdAt);
      expect(await listIds()).toEqual([second.id, first.id]);
      expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(firstRename.updatedAt));

      const secondRename = await renameFirst('A-2');
      expect(await listIds()).toEqual([first.id, second.id]);
      expect(Date.parse(secondRename.updatedAt)).toBeGreaterThan(Date.parse(second.updatedAt));
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks deleting an active session and cascades database rows with the trace bytes intact', async () => {
    const app = openTestApp();
    const session = await create(app, directoryA);
    const db = openAppDatabase(dbPath);
    try {
      seedRun(db, 'run_guard', session.id, 'running');
      seedArtifact(db, 'run_guard', session.id);
      db.prepare(`
        INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at)
        VALUES ('run_guard', 1, 'turn_start', '{}', ?)
      `).run(createdAt);
      const deleteRequest = { method: 'DELETE' as const, url: sessionsUrl + '/' + session.id };
      expectError(await app.inject(deleteRequest), 409, 'SESSION_HAS_ACTIVE_RUN');
      expect(runStatus(db, 'run_guard')).toBe('running');
      db.prepare("UPDATE investigation_runs SET status = 'completed' WHERE id = 'run_guard'").run();
      const response = await app.inject(deleteRequest);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ deleted: true, id: session.id });
      for (const table of ['sessions', 'investigation_runs', 'run_events', 'artifacts']) {
        expect(db.prepare('SELECT count(*) FROM ' + table).pluck().get()).toBe(0);
      }
      expect(fs.statSync(directoryA).isDirectory()).toBe(true);
      expect(fs.readFileSync(sample, 'utf8')).toBe(sampleText);
    } finally {
      db.close();
    }
  });

  it('slices a directory trace using original line numbers, filtering, CRLF/LF and EOF', async () => {
    const app = openTestApp();
    const session = await create(app, directoryA);
    const query = { file: 'sample.LOG', startLine: '2', limit: '1', level: 'warn', q: 'NEEDLE' };
    const first = await app.inject(fileSlice(session.id, query));
    expect(first.statusCode, first.body).toBe(200);
    expect(TextSliceResponseSchema.parse(first.json())).toEqual({
      totalLines: 5, matchedLines: 2, offsetLine: 2, limit: 1, hasMore: true, nextOffsetLine: 5,
      lines: [{ lineNumber: 2, level: 'warn', text: 'WARN needle' }],
    });
    const last = await app.inject(fileSlice(session.id, { ...query, startLine: '5' }));
    expect(last.statusCode).toBe(200);
    expect(TextSliceResponseSchema.parse(last.json())).toMatchObject({
      offsetLine: 5, hasMore: false, nextOffsetLine: null, lines: [{ lineNumber: 5, text: 'WARN Needle again' }],
    });
    const eof = await app.inject(fileSlice(session.id, { ...query, startLine: '50' }));
    expect(eof.statusCode).toBe(200);
    expect(TextSliceResponseSchema.parse(eof.json())).toMatchObject({
      totalLines: 5, matchedLines: 2, offsetLine: 50, hasMore: false, nextOffsetLine: null, lines: [],
    });
    fs.writeFileSync(join(directoryA, 'empty.txt'), '');
    const empty = await app.inject(fileSlice(session.id, { file: 'empty.txt' }));
    expect(empty.statusCode).toBe(200);
    expect(TextSliceResponseSchema.parse(empty.json())).toEqual({
      totalLines: 0, matchedLines: 0, offsetLine: 1, limit: 200, hasMore: false, nextOffsetLine: null, lines: [],
    });
  });

  it('keeps requests within a file session even when a different path does not exist', async () => {
    const app = openTestApp();
    const session = await create(app, sample);
    for (const path of [fileSlice(session.id), fileSlice(session.id, { file: sample }),
      fileSlice(session.id, { file: 'sample.LOG' })]) {
      const response = await app.inject(path);
      expect(response.statusCode, response.body).toBe(200);
      expect(TextSliceResponseSchema.parse(response.json())).toMatchObject({ offsetLine: 1, totalLines: 5 });
    }
    const different = join(directoryA, 'different.json');
    const outside = join(fixture, 'outside.json');
    for (const path of [different, outside]) {
      fs.writeFileSync(path, '{}');
      expectError(await app.inject(fileSlice(session.id, { file: path })), 403, 'PATH_OUTSIDE_SESSION_SCOPE');
    }
    expectError(await app.inject(fileSlice(session.id, { file: 'missing.json' })), 403, 'PATH_OUTSIDE_SESSION_SCOPE');
  });

  it('rejects traversal, Junctions, and a rebound session target within the global whitelist', async () => {
    const app = openTestApp();
    const session = await create(app, directoryA);
    const other = join(directoryB, 'other.json');
    fs.writeFileSync(other, '{}');
    makeDirectoryLink(directoryB, join(directoryA, 'reparse'));
    for (const file of ['../trace-b/other.json', other, 'reparse/other.json', 'reparse/missing.json']) {
      expectError(await app.inject(fileSlice(session.id, { file })), 403, 'PATH_OUTSIDE_SESSION_SCOPE');
    }
    fs.renameSync(directoryA, join(root, 'moved'));
    makeDirectoryLink(directoryB, directoryA);
    expectError(await app.inject(fileSlice(session.id, { file: 'other.json' })), 403, 'PATH_OUTSIDE_SESSION_SCOPE');
  });

  it('keeps 400, 403, 404 and 413 file-slice errors distinct', async () => {
    const app = openTestApp({ maxFileSliceBytes: 5 });
    const session = await create(app, directoryA);
    fs.mkdirSync(join(directoryA, 'sub'));
    for (const name of ['.env', 'unsupported.bin']) fs.writeFileSync(join(directoryA, name), 'fixture');
    for (const { file, status, code } of [
      { file: 'sub', status: 400, code: 'PATH_NOT_A_FILE' },
      { file: '.env', status: 403, code: 'PATH_FORBIDDEN' },
      { file: 'unsupported.bin', status: 400, code: 'UNSUPPORTED_TRACE_FILE' },
      { file: 'missing.json', status: 404, code: 'PATH_NOT_FOUND' },
      { file: 'sample.LOG', status: 413, code: 'FILE_TOO_LARGE' },
    ]) {
      expectError(await app.inject(fileSlice(session.id, { file })), status, code);
    }
    expectError(await app.inject(fileSlice(session.id)), 400, 'INVALID_PATH');
    for (const invalid of ['startLine=0', 'startLine=1.5', 'startLine=9007199254740992', 'limit=201',
      'limit=0', 'level=verbose', 'startLine=1&startLine=2', 'q=a&q=b', 'file=a&file=b']) {
      expectError(await app.inject(fileSlice(session.id) + '?' + invalid), 400, 'INVALID_REQUEST');
    }
    expectError(await app.inject(fileSlice('bad')), 400, 'INVALID_REQUEST');
    expectError(await app.inject(fileSlice('ses_missing')), 404, 'SESSION_NOT_FOUND');
  });

  it('discards a replaced file object and closes the opened descriptor without reading it', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const replacement = join(directoryA, 'replacement.log');
    fs.writeFileSync(replacement, 'other contents');
    const open = vi.mocked(fs.openSync).mockImplementationOnce((path, flags) => {
      actual.renameSync(sample, join(directoryA, 'original.log'));
      actual.renameSync(replacement, sample);
      return actual.openSync(path, flags);
    });
    expect(() => readSafeSessionFile({ targetPath: sample, pathType: 'file' }, undefined, [root]))
      .toThrow(expect.objectContaining({ statusCode: 403, code: 'PATH_FORBIDDEN' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(open.mock.results[0]?.value);
  });

  it('bounds growth after fstat to maxBytes + 1 on a single descriptor and closes it', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    fs.writeFileSync(sample, '12345');
    const read = vi.mocked(fs.readSync).mockImplementationOnce((...args) => {
      actual.appendFileSync(sample, '6789012345');
      return Reflect.apply(actual.readSync, undefined, args);
    });
    expect(() => readSafeSessionFile({ targetPath: sample, pathType: 'file' }, undefined, [root], { maxBytes: 5 }))
      .toThrow(expect.objectContaining({ statusCode: 413, code: 'FILE_TOO_LARGE' }));
    const fd = vi.mocked(fs.openSync).mock.results[0]?.value;
    expect(fs.openSync).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.slice(0, 5)).toEqual([fd, expect.any(Buffer), 0, 6, null]);
    expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(fd);
  });

  it('indexes every structured trace error at its physical line and excludes descriptive text', async () => {
    const app = openTestApp();
    const raw = [
      '{',
      '  "messages": [',
      '    {"role":"tool","content":"Error: first failure"},',
      '    {"event":{"type":"tool_execution_end","isError":',
      '      true}},',
      '    ' + JSON.stringify({ role: 'tool', content: '{"status":"failed"}' }) + ',',
      '    {"role":"tool","isError":false,"content":"Error: resolved"},',
      '    {"role":"assistant","content":"Critical example"},',
      '    {"level":"warning","message":"Example"},',
      '    {"toolCalls":[',
      '      {"toolName":"one","isError":true},',
      '      {"toolName":"two","is_error":true}',
      '    ]}',
      '  ],',
      '  "metadata":{"reward":0,"extra":{"agent_framework_description":"Critical setup"}}',
      '}',
    ];
    const path = join(directoryA, 'structured.json');
    fs.writeFileSync(path, raw.join('\r\n'));
    const session = await create(app, path);
    const read = async (query: Record<string, string | number> = {}) => {
      const response = await app.inject(fileSlice(session.id, query));
      expect(response.statusCode).toBe(200);
      return TextSliceResponseSchema.parse(response.json());
    };
    const full = await read();
    const errorLines = [3, 5, 6, 11, 12];
    expect(full.lines.filter(({ level }) => level === 'error').map(({ lineNumber }) => lineNumber)).toEqual(errorLines);
    expect(full.lines.filter(({ level }) => level === 'warn').map(({ lineNumber }) => lineNumber)).toEqual([9]);
    expect(full.lines.map(({ text }) => text)).toEqual(raw);
    const first = await read({ level: 'error', limit: 2 });
    expect(first).toMatchObject({ matchedLines: 5, hasMore: true, nextOffsetLine: 6 });
    const second = await read({ level: 'error', startLine: 6 });
    expect(second).toMatchObject({ matchedLines: 5, hasMore: false, nextOffsetLine: null });
    expect([...first.lines, ...second.lines].map(({ lineNumber }) => lineNumber)).toEqual(errorLines);
  });

  it('recognizes structured errors in mixed logs while respecting explicit successes', () => {
    const lines = [
      '{"message":"Critical documentation", "isError":false}',
      'INFO ready',
      '{"status":"failed","message":"lookup unavailable"}',
      'ERROR plain text failure',
      '{"role":"tool","content":{"success":false,"error":"denied"}}',
      '{"level":"error","message":"explicit error record"}',
      '{"role":"assistant","content":"Use ERROR to label a failure"}',
    ];
    const response = sliceTextContent(lines.join('\n'), { offsetLine: 1, limit: 200, level: 'error' });
    expect(response.matchedLines).toBe(4);
    expect(response.lines.map(({ lineNumber }) => lineNumber)).toEqual([3, 4, 5, 6]);
  });

  it('walks filtered pages monotonically and returns each matching line once', () => {
    const choices = [
      { text: 'INFO status', level: 'info' }, { text: '{"level":"debug"}', level: 'info' },
      { text: 'WARN needle', level: 'warn' }, { text: '{"level":"warning"}', level: 'warn' },
      { text: 'WARN then FATAL', level: 'error' }, { text: '{"isError": true}', level: 'error' },
      { text: 'unclassified', level: 'other' }, { text: 'Needle fragment', level: 'other' },
    ] satisfies { text: string; level: LogLevel }[];
    const arbitraryLine = fc.tuple(fc.constantFrom(...choices), fc.nat(999), fc.boolean());
    const count = fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 200 }));
    fc.assert(fc.property(
      fc.array(arbitraryLine, { maxLength: 110 }), count, fc.option(fc.constantFrom<LogLevel>('info', 'warn', 'error', 'other')),
      fc.option(fc.constantFrom('needle', 'INFO', 'xyz', '')), fc.boolean(),
      (rows, limit, level, q, trailingNewline) => {
        const lines = rows.map(([line, number], index) => ({
          lineNumber: index + 1, level: line.level, text: line.text + ' ' + number,
        }));
        const content = lines.map((line, index) => index < lines.length - 1 || trailingNewline
          ? line.text + (rows[index]?.[2] ? '\r\n' : '\n') : line.text).join('');
        const matched = lines.filter((line) => (!level || line.level === level)
          && (!q || line.text.toLowerCase().includes(q.toLowerCase())));
        const paged = [];
        let offsetLine = 1;
        for (let attempts = 0; attempts <= lines.length; attempts += 1) {
          const page = sliceTextContent(content, { offsetLine, limit, level: level ?? undefined, q: q ?? undefined });
          expect(page.totalLines).toBe(lines.length);
          expect(page.matchedLines).toBe(matched.length);
          expect(page.lines.length).toBeLessThanOrEqual(limit);
          paged.push(...page.lines);
          if (!page.hasMore) {
            expect(page.nextOffsetLine).toBeNull();
            expect(paged).toEqual(matched);
            return;
          }
          if (page.nextOffsetLine === null) throw new Error('Expected the next matching line number.');
          expect(page.nextOffsetLine).toBeGreaterThan(offsetLine);
          offsetLine = page.nextOffsetLine;
        }
        throw new Error('Pagination failed to terminate.');
      },
    ), { numRuns: 128, seed: 20261125 });
  });
});
