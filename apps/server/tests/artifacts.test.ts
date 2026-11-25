import type { ToolExecutionContext } from '@mini-agent-run/agent';
import {
  ArtifactMetaSchema, MAX_INLINE_TOOL_OUTPUT_BYTES, SessionSchema, TextSliceResponseSchema, type Session,
} from '@mini-agent-run/shared';
import { createToolRegistry, summarizeToolOutput, wrapToolsWithArtifactOffload } from '@mini-agent-run/tools';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openAppDatabase } from '../src/db/database.js';
import { WORKSPACE_ROOT } from '../src/fs/path-sandbox.js';
import { createServerTraceWorkspace } from '../src/fs/trace-workspace.js';

const demo = join(WORKSPACE_ROOT, 'data', 'fixtures', 'diagnostic-demo');
const runId = 'run_artifact_test';
const createdAt = '2026-11-25T00:00:00.000Z';
const xssLine = '<script>window.__xss=1</script> <img src=x onerror=alert(1)>';

async function withDatabase(test: (dbPath: string, temp: string) => Promise<void>) {
  const parent = realpathSync.native(tmpdir());
  const temp = mkdtempSync(join(parent, 'm15-artifacts-'));
  if (dirname(temp) !== parent) throw new Error('Unexpected temporary database directory.');
  try {
    await test(join(temp, 'test.db'), temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

type App = ReturnType<typeof buildApp>;

async function bind(app: App, targetPath: string) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath } });
  expect(response.statusCode, response.body).toBe(201);
  return SessionSchema.parse(response.json());
}

function seedRun(dbPath: string, sessionId: string) {
  const db = openAppDatabase(dbPath);
  try {
    db.prepare(`INSERT INTO investigation_runs
      (id, session_id, prompt, status, stop_reason, model_provider, model_id, tool_mode, created_at)
      VALUES (?, ?, 'Artifact test', 'completed', 'completed', 'mock', 'test-model', 'mock', ?)
    `).run(runId, sessionId, createdAt);
    db.prepare(`INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at)
      VALUES (?, 1, 'agent_end', '{}', ?)`).run(runId, createdAt);
  } finally {
    db.close();
  }
}

function artifactInput(sessionId: string, content: string) {
  return {
    runId, sessionId, toolCallId: 'tc_artifact', sourceTool: 'test_tool', title: 'Artifact test',
    contentType: 'text/plain' as const, content, summary: summarizeToolOutput(content),
  };
}

function toolsFor(app: App, session: Session, allowedRoots: readonly string[] = [demo]) {
  const artifactStore = app.artifactStore;
  const workspace = createServerTraceWorkspace(session);
  const registry = createToolRegistry({ toolMode: 'mock', artifactStore, workspace });
  const ctx: ToolExecutionContext = {
    runId, sessionId: session.id, toolCallId: 'tc_real_search', targetPath: session.targetPath,
    allowedRoots, toolMode: 'mock', signal: new AbortController().signal, artifactStore,
  };
  const run = (tools: typeof registry, name: string, args: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error('Missing tool ' + name);
    return tool.execute(args, ctx);
  };
  const wrapped = wrapToolsWithArtifactOffload(registry);
  return {
    raw: (name: string, args: Record<string, unknown>) => run(registry, name, args),
    call: (name: string, args: Record<string, unknown>) => run(wrapped, name, args),
  };
}

async function readHttp(app: App, id: string, query = '') {
  const response = await app.inject('/api/artifacts/' + id + query);
  expect(response.statusCode, response.body).toBe(200);
  const data = response.json();
  return { artifact: ArtifactMetaSchema.parse(data.artifact), slice: TextSliceResponseSchema.parse(data.slice) };
}

describe('[F04_LARGE_ARTIFACT_STORE] SQLite persistence, HTTP and tool slice coordinates', () => {
  it('persists exact content, rejects cross-session and missing runs, and clears all four tables on delete', () =>
    withDatabase(async (dbPath) => {
      const first = buildApp({ dbPath, allowedTraceRoots: [demo] });
      let sessionId: string;
      let artifactId: string;
      const content = 'INFO 春\u0000🙂\r\nWARN lone \uD800 surrogate\n\n';
      try {
        const session = await bind(first, demo);
        sessionId = session.id;
        const second = await bind(first, demo);
        seedRun(dbPath, sessionId);
        const input = artifactInput(sessionId, content);
        const saved = await first.artifactStore.save(input);
        artifactId = saved.id;
        expect(saved).toMatchObject({
          byteSize: Buffer.byteLength(content), lineCount: 3, toolCallId: input.toolCallId, summary: input.summary,
        });
        expect(() => first.artifactStore.save({ ...input, sessionId: second.id })).toThrow(/FOREIGN KEY/);
        expect(() => first.artifactStore.save({ ...input, runId: 'run_missing' })).toThrow(/FOREIGN KEY/);
        expect(() => first.artifactStore.save({ ...input, toolCallId: 'invalid' })).toThrow();
        expect(() => first.artifactStore.save({ ...input, sourceTool: '  ' })).toThrow();
        expect(await first.artifactStore.getMeta('invalid')).toBeNull();
        await expect(async () => first.artifactStore.readSlice(artifactId, { offsetLine: 0, limit: 5 })).rejects.toThrow();
        expect((await first.inject({ method: 'DELETE', url: '/api/sessions/' + second.id })).statusCode).toBe(200);
      } finally {
        await first.close();
      }
      const reopened = buildApp({ dbPath });
      try {
        const { artifact, slice } = await readHttp(reopened, artifactId);
        expect(await reopened.artifactStore.getMeta(artifactId)).toEqual(artifact);
        expect(slice.lines.map(({ text }) => text)).toEqual(['INFO 春\u0000🙂', 'WARN lone \uD800 surrogate', '']);
        expect((await reopened.inject({ method: 'DELETE', url: '/api/sessions/' + sessionId })).statusCode).toBe(200);
        expect(await reopened.artifactStore.getMeta(artifactId)).toBeNull();
        expect(await reopened.artifactStore.readSlice(artifactId, { offsetLine: 1, limit: 1 })).toBeNull();
        const reader = openAppDatabase(dbPath);
        try {
          for (const table of ['sessions', 'investigation_runs', 'run_events', 'artifacts']) {
            expect(reader.prepare('SELECT COUNT(*) AS count FROM ' + table).get()).toEqual({ count: 0 });
          }
        } finally {
          reader.close();
        }
      } finally {
        await reopened.close();
      }
    }));

  it('paginates and filters with the same classification as the summary while keeping F02 and XSS text intact', () =>
    withDatabase(async (dbPath, temp) => {
      const content = ['INFO begin', '{"status":"failed"}', 'WARN ' + xssLine, 'ERROR root cause',
        ...Array.from({ length: 25 }, (_, index) => 'INFO ' + index + ' ' + '中'.repeat(100)), ''].join('\r\n');
      const file = 'output.log';
      writeFileSync(join(temp, file), content);
      const app = buildApp({ dbPath, allowedTraceRoots: [temp] });
      try {
        const session = await bind(app, temp);
        seedRun(dbPath, session.id);
        const saved = await app.artifactStore.save(artifactInput(session.id, content));
        expect(saved.byteSize).toBeGreaterThan(MAX_INLINE_TOOL_OUTPUT_BYTES);
        const page = await readHttp(app, saved.id, '?offsetLine=2&limit=2');
        expect(page.artifact).toEqual(saved);
        expect(page.slice).toMatchObject({ totalLines: 29, matchedLines: 29, hasMore: true, nextOffsetLine: 4,
          lines: [{ lineNumber: 2, level: 'error', text: '{"status":"failed"}' },
            { lineNumber: 3, level: 'warn', text: 'WARN ' + xssLine }],
        });
        const errors = await readHttp(app, saved.id, '?level=error');
        expect(saved.summary).toMatchObject({ firstErrorLine: 2, levelCounts: { error: 2, warn: 1, info: 26, other: 0 } });
        expect(errors.slice.lines.map((line) => line.lineNumber)).toEqual([2, 4]);
        const tools = toolsFor(app, session, [temp]);
        const result = await tools.call('read_artifact_slice', { artifactId: saved.id, level: 'error' });
        expect(result.isError).toBe(false);
        expect(TextSliceResponseSchema.parse(JSON.parse(result.content))).toEqual(errors.slice);
        const exactXss = await readHttp(app, saved.id, '?q=' + encodeURIComponent('<script>'));
        expect(exactXss.slice.lines).toEqual([{ lineNumber: 3, level: 'warn', text: 'WARN ' + xssLine }]);

        const source = await app.inject('/api/sessions/' + session.id + '/file-slice?file=' + file + '&level=error');
        expect(source.statusCode).toBe(200);
        expect(TextSliceResponseSchema.parse(source.json()).lines).toEqual([{ lineNumber: 4, level: 'error', text: 'ERROR root cause' }]);

        for (const path of ['invalid', saved.id + '?offsetLine=0', saved.id + '?offsetLine=1e2', saved.id + '?limit=201',
          saved.id + '?level=debug', saved.id + '?q=a&q=b', saved.id + '?limit=1&limit=2']) {
          const response = await app.inject('/api/artifacts/' + path);
          expect(response.statusCode, path).toBe(400);
          expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
        }
        const missing = await app.inject('/api/artifacts/art_missing');
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
      } finally {
        await app.close();
      }
    }));

  it('offloads real search JSON, returns the bounded tool prefix and follows a source coordinate after exact HTTP readback', () =>
    withDatabase(async (dbPath) => {
      const file = 'noisy-large-xss.log';
      const sourcePath = join(demo, file);
      const sourceBefore = readFileSync(sourcePath);
      const app = buildApp({ dbPath, allowedTraceRoots: [demo] });
      try {
        const session = await bind(app, demo);
        const other = await bind(app, demo);
        seedRun(dbPath, session.id);
        const tools = toolsFor(app, session);
        const args = { file, query: 'INFO' };
        const raw = await tools.raw('search_logs', args);
        const result = await tools.call('search_logs', args);
        expect(raw.isError).toBe(false);
        expect(Buffer.byteLength(raw.content)).toBeGreaterThan(MAX_INLINE_TOOL_OUTPUT_BYTES);
        expect(result.isError).toBe(false);
        expect(result.summary).toMatchObject({ truncatedForLlm: true, lineCount: 1 });
        expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(MAX_INLINE_TOOL_OUTPUT_BYTES);
        const id = ArtifactMetaSchema.shape.id.parse(result.artifactId);
        expect(JSON.parse(result.content).artifactId).toBe(id);

        const toolSlice = await tools.call('read_artifact_slice', { artifactId: id, limit: 50 });
        expect(toolSlice.isError).toBe(false);
        expect(Buffer.byteLength(toolSlice.content)).toBeLessThanOrEqual(MAX_INLINE_TOOL_OUTPUT_BYTES);
        const bounded = JSON.parse(toolSlice.content);
        expect(bounded).toMatchObject({ lineTruncated: true, totalLines: 1, lines: [{ lineNumber: 1 }] });
        const prefix = TextSliceResponseSchema.parse(bounded).lines[0]?.text;
        expect(prefix).toBeTruthy();
        expect(raw.content.startsWith(prefix ?? '')).toBe(true);
        const { artifact, slice } = await readHttp(app, id, '?offsetLine=1&limit=50');
        expect(artifact).toMatchObject({ sessionId: session.id, toolCallId: 'tc_real_search', contentType: 'application/json' });
        const stored = slice.lines[0]?.text;
        expect(stored).toBe(raw.content);
        expect(slice.totalLines).toBe(1);
        const denied = await toolsFor(app, other).call('read_artifact_slice', { artifactId: id });
        expect(denied.isError).toBe(true);
        expect(JSON.parse(denied.content)).toMatchObject({ error: { code: 'ARTIFACT_FORBIDDEN' } });

        const { matches: [hit] } = JSON.parse(stored ?? '');
        const query = new URLSearchParams({ file: hit.file, startLine: String(hit.lineNumber), limit: '5' });
        const source = await app.inject('/api/sessions/' + session.id + '/file-slice?' + query.toString());
        expect(source.statusCode).toBe(200);
        expect(TextSliceResponseSchema.parse(source.json()).lines[0]).toMatchObject({
          lineNumber: hit.lineNumber, text: hit.text,
        });
        expect((await app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id })).statusCode).toBe(200);
        const after = await app.inject('/api/artifacts/' + id);
        expect(after.statusCode).toBe(404);
        expect(after.json()).toMatchObject({ error: { code: 'ARTIFACT_NOT_FOUND' } });
        expect(readFileSync(sourcePath)).toEqual(sourceBefore);
      } finally {
        await app.close();
      }
    }));
});
