import type { ArtifactStorePort, ToolExecutionContext } from '@mini-agent-run/agent';
import { ArtifactMetaSchema, FsBrowseResponseSchema, SessionSchema, TextSliceResponseSchema,
  TraceOverviewSchema, type Session } from '@mini-agent-run/shared';
import { createToolRegistry } from '@mini-agent-run/tools';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { WORKSPACE_ROOT } from '../src/fs/path-sandbox.js';
import { createServerTraceWorkspace } from '../src/fs/trace-workspace.js';

const demo = join(WORKSPACE_ROOT, 'data', 'fixtures', 'diagnostic-demo');
const names = ['agent-run-failed.jsonl', 'agent-run-passed.jsonl', 'diagnostics.fixture.json', 'noisy-large-xss.log'];
const now = '2026-11-25T00:00:00.000Z';
const iso = { sessionId: 'ses_default', runId: 'run_example' };

const storeFor = (sessionId: string): ArtifactStorePort => ({
  save: () => { throw new Error('Fixture store is read only'); },
  getMeta: (id) => id === 'art_example' ? ArtifactMetaSchema.parse({
    id, sessionId, runId: 'run_example', toolCallId: 'tc_example', sourceTool: 'search_logs',
    title: 'local output', contentType: 'text/plain', byteSize: 8, lineCount: 1, createdAt: now,
    summary: { byteSize: 8, lineCount: 1, truncatedForLlm: true,
      levelCounts: { error: 0, warn: 0, info: 1, other: 0 }, firstErrorLine: null, previewHead: 'original' },
  }) : null,
  readSlice: (_id, { offsetLine, limit }) => ({
    totalLines: 1, matchedLines: 1, offsetLine, limit, hasMore: false, nextOffsetLine: null,
    lines: offsetLine === 1 ? [{ text: 'original', level: 'info', lineNumber: 1 }] : [],
  }),
});

function runner(session: Pick<Session, 'targetPath' | 'pathType'> & { id?: string }, roots: readonly string[]) {
  const sessionId = session.id ?? iso.sessionId;
  const workspace = createServerTraceWorkspace(session);
  const artifactStore = storeFor(sessionId);
  const registry = createToolRegistry({ toolMode: 'mock', artifactStore, workspace });
  const ctx: ToolExecutionContext = {
    runId: iso.runId, sessionId, targetPath: session.targetPath, toolMode: 'mock',
    allowedRoots: roots, signal: new AbortController().signal, artifactStore,
  };
  return async (name: string, args: Record<string, unknown> = {}, options: Partial<ToolExecutionContext> = {}) => {
    const tool = registry.find((item) => item.name === name);
    if (!tool) throw new Error('Missing tool');
    const reply = await tool.execute(args, { ...ctx, ...options });
    return { ...reply, data: JSON.parse(reply.content) };
  };
}

async function bind(app: ReturnType<typeof buildApp>, targetPath: string) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath } });
  expect(response.statusCode, response.body).toBe(201);
  return SessionSchema.parse(response.json());
}

async function withFixture(run: (temp: string) => Promise<void>) {
  const parent = fs.realpathSync.native(tmpdir());
  const temp = fs.mkdtempSync(join(parent, 'm14-workspace-'));
  if (dirname(temp) !== parent) throw Error('Unexpected workspace fixture directory');
  try {
    await run(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function junction(target: string, link: string) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('server session trace workspace integration', () => {
  it('runs all seven tools against a persisted session and matches the HTTP file-slice coordinates', async () => {
    const app = buildApp();
    try {
      const session = await bind(app, demo);
      const detail = await app.inject('/api/sessions/' + session.id);
      expect(detail.json().session).toEqual(session);
      const run = runner(detail.json().session, ['./data/fixtures']);
      const browse = await app.inject('/api/fs/browse?path=' + encodeURIComponent(demo));
      expect(FsBrowseResponseSchema.parse(browse.json()).entries.map(({ name }) => name)).toEqual(names);
      const listing = await run('list_files');
      expect(listing.data).toMatchObject({ files: names.map((path) => ({ path })), total: 4, truncated: false });
      const log = TraceOverviewSchema.parse((await run('inspect_trace', { file: 'noisy-large-xss.log' })).data);
      expect(log.lineCount).toBeGreaterThanOrEqual(2000);
      expect(log.anomalies.firstError?.line).toBe(1100);
      expect(log.anomalies.slowSpans).toEqual([
        expect.objectContaining({ durationMs: 3450 }), expect.objectContaining({ durationMs: 5120 }),
      ]);
      expect(fs.readFileSync(join(demo, 'noisy-large-xss.log'), 'utf8')).toMatch(/<script[\s\S]*<img[^>]+onerror/);
      expect(names.reduce((total, name) => total + fs.statSync(join(demo, name)).size, 0)).toBeGreaterThan(250_000);
      expect(names.reduce((total, name) => total + fs.statSync(join(demo, name)).size, 0)).toBeLessThan(400_000);

      const query = { file: 'noisy-large-xss.log', startLine: 1100, limit: 1 };
      const httpResponse = await app.inject('/api/sessions/' + session.id + '/file-slice?' +
        new URLSearchParams({ file: query.file, startLine: String(query.startLine), limit: '1' }).toString());
      expect(httpResponse.statusCode).toBe(200);
      const line = TextSliceResponseSchema.parse(httpResponse.json()).lines[0];
      expect((await run('read_file_slice', query)).data.lines).toEqual([line]);
      const found = await run('search_logs', { query: 'root cause:', file: query.file, level: 'error' });
      expect(found.data.matches).toEqual([expect.objectContaining({ lineNumber: line?.lineNumber, text: line?.text })]);

      const failed = TraceOverviewSchema.parse((await run('inspect_trace', { file: names[0] })).data);
      expect(failed.threeState).toMatchObject({ taskOutcome: 'failed', hasToolError: true });
      expect(failed.anomalies.retryLoops).toEqual([{
        toolName: 'read_file_slice', startStep: 4, endStep: 6, repeatCount: 3,
      }]);
      const compare = await run('compare_files', { fileA: names[0], fileB: names[1] });
      expect(compare.data).toMatchObject({
        firstDivergenceStep: 4, threeStateDiff: { taskOutcome: { fileA: 'failed', fileB: 'passed' } },
      });
      expect((await run('read_artifact_slice', { artifactId: 'art_example' })).data.lines)
        .toEqual([{ text: 'original', level: 'info', lineNumber: 1 }]);

      expect((await run('check_runtime_diagnostics', { scenario: 'error' })).data.error.code).toBe('MOCK_UPSTREAM_TIMEOUT');
      expect((await run('check_runtime_diagnostics', {}, { toolMode: 'live' })).data)
        .toMatchObject({ mode: 'live', fileCount: 4, accessible: true, pathType: 'dir' });
    } finally {
      await app.close();
    }
  });

  it('locates the multiline JSON error value at the same original line as search and the HTTP slice', async () => {
    await withFixture(async (temp) => {
      const file = 'split-level.json';
      const lines = [
        '{', '  "metadata": {"annotation":"private test value"},', '  "steps": [', '    {', '      "step": 7,',
        '      "toolName": "lookup",', '      "level":', '        "error"', '    }', '  ]', '}',
      ];
      fs.writeFileSync(join(temp, file), lines.join('\r\n'));
      const app = buildApp({ allowedTraceRoots: [temp] });
      try {
        const session = await bind(app, temp);
        const run = runner(session, [temp]);
        const inspection = await run('inspect_trace', { file });
        const found = await run('search_logs', { file, query: '"error"' });
        expect(found.data.matches).toMatchObject([{ lineNumber: 8, text: lines[7] }]);
        const tool = await run('read_file_slice', { file, startLine: 8, limit: 1 });
        const response = await app.inject('/api/sessions/' + session.id + '/file-slice?' +
          new URLSearchParams({ file, startLine: '8', limit: '1' }).toString());
        expect(response.statusCode).toBe(200);
        const originalLine = TextSliceResponseSchema.parse(response.json()).lines[0];
        expect(originalLine).toMatchObject({ lineNumber: 8, text: lines[7] });
        expect(tool.data.lines).toEqual([originalLine]);
        expect(inspection.content).not.toContain('private test value');
        expect(TraceOverviewSchema.parse(inspection.data).anomalies.firstError)
          .toEqual({ step: 7, line: 8, snippet: '"error"' });
      } finally {
        await app.close();
      }
    });
  });

  it('lists bounded POSIX paths and rejects escapes and forbidden segments through the real sandbox', async () => {
    await withFixture(async (temp) => {
      const a = join(temp, 'a');
      const b = join(temp, 'b');
      const sub = join(a, 'inside');
      for (const dir of [a, b, sub, join(a, '.git')]) fs.mkdirSync(dir);
      fs.writeFileSync(join(a, 'public.txt'), 'visible');
      fs.writeFileSync(join(a, 'ignored.exe'), 'executable fixture');
      fs.writeFileSync(join(a, '.env'), 'protected fixture');
      fs.writeFileSync(join(a, '.git', 'hidden.json'), '{}');
      fs.writeFileSync(join(b, 'other.json'), '{"message":"outside"}');
      fs.writeFileSync(join(sub, '文.json'), '{}');
      junction(b, join(a, 'escape'));
      junction(a, join(sub, 'loop'));
      const app = buildApp({ allowedTraceRoots: [temp] });
      try {
        const session = await bind(app, a);
        const run = runner(session, [temp]);
        const listing = await run('list_files');
        expect(listing.data).toMatchObject({ files: [{ path: 'inside/文.json' }, { path: 'public.txt' }],
          total: 2, truncated: false });
        expect((await run('list_files', { maxDepth: 0 })).data).toMatchObject({
          files: [{ path: 'public.txt' }], total: 1, truncated: true,
        });
        expect((await run('list_files', { maxFiles: 1 })).data).toMatchObject({ total: 1, truncated: true });
        for (const file of ['../b/other.json', join(b, 'other.json'), 'escape/other.json', 'escape/missing.json', '.env']) {
          const result = await run('inspect_trace', { file });
          expect(result.isError).toBe(true);
          expect(result.content).not.toMatch(/protected fixture|outside"/);
          expect(result.data.error.code).toBe(file === '.env' ? 'PATH_FORBIDDEN' : 'PATH_OUTSIDE_SESSION_SCOPE');
        }
        const single = await bind(app, join(sub, '文.json'));
        const singleFile = runner(single, [temp]);
        expect((await singleFile('list_files')).data).toMatchObject({
          files: [{ path: '文.json', byteSize: 2 }], total: 1, truncated: false,
        });
        expect((await singleFile('inspect_trace')).data.file).toBe('文.json');
        expect((await singleFile('inspect_trace', { file: '../public.txt' })).isError).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  it('holds the stored binding when a file or junction changes after session creation', async () => {
    await withFixture(async (temp) => {
      const dir = join(temp, 'first');
      const replacement = join(temp, 'second');
      const file = join(temp, 'single.json');
      fs.mkdirSync(dir);
      fs.mkdirSync(replacement);
      fs.writeFileSync(file, '{}');
      fs.writeFileSync(join(replacement, 'visible.json'), '{"message":"replacement-only"}');
      const app = buildApp({ allowedTraceRoots: [temp] });
      try {
        const fileSession = await bind(app, file);
        const dirSession = await bind(app, dir);
        const binding = { targetPath: dirSession.targetPath, pathType: dirSession.pathType };
        const workspace = createServerTraceWorkspace(binding);
        binding.targetPath = replacement;
        expect(workspace.binding).toEqual({ targetPath: dirSession.targetPath, pathType: 'dir' });
        expect(Object.isFrozen(workspace.binding)).toBe(true);
        fs.unlinkSync(file);
        fs.mkdirSync(file);
        fs.rmdirSync(dir);
        junction(replacement, dir);
        for (const [session, code, request] of [
          [fileSession, 'PATH_NOT_A_FILE', undefined], [dirSession, 'PATH_OUTSIDE_SESSION_SCOPE', 'visible.json'],
        ] as const) {
          const run = runner(session, [temp]);
          expect((await run('list_files')).data.error.code).toBe(code);
          expect((await run('inspect_trace', request ? { file: request } : {})).data.error.code).toBe(code);
          const suffix = request ? '?file=' + encodeURIComponent(request) : '';
          const slice = await app.inject('/api/sessions/' + session.id + '/file-slice' + suffix);
          expect(slice.statusCode).toBe(request ? 403 : 400);
          expect(slice.json().error.code).toBe(code);
        }
      } finally {
        await app.close();
      }
    });
  });

  it('uses local training samples when the external training directory exists', async () => {
    const training = resolve(WORKSPACE_ROOT, '../Database/new data/TrajErrBench/train');
    if (!fs.existsSync(training)) return;
    const root = fs.realpathSync.native(training);
    const run = runner({ targetPath: root, pathType: 'dir' }, [root]);
    const listing = await run('list_files');
    expect(listing.isError).toBe(false);
    const samples = listing.data.files.slice(0, 3);
    expect(samples).toHaveLength(3);
    for (const { path } of samples) {
      const sample = await run('inspect_trace', { file: path });
      expect(sample.isError, sample.content).toBe(false);
      expect(TraceOverviewSchema.parse(sample.data).format).toBe('trajerrbench_json');
      expect(sample.content).not.toMatch(/"annotation"|"critical_error_(?:step|type)"|"ground_truth"/);
    }
  });
});
