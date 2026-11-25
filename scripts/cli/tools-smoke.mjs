import {
  ArtifactMetaSchema, FsBrowseResponseSchema, MAX_INLINE_TOOL_OUTPUT_BYTES, SessionSchema, TextSliceResponseSchema,
  TraceOverviewSchema,
} from '@mini-agent-run/shared';
import {
  createToolRegistry, offloadOversizedToolOutput, sanitizeTraceContent, wrapToolsWithArtifactOffload,
} from '@mini-agent-run/tools';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const defaultPath = './data/fixtures/diagnostic-demo';
const defaultLog = 'noisy-large-xss.log';
const runId = 'run_tools_smoke';
const limit = MAX_INLINE_TOOL_OUTPUT_BYTES;

function seedRun(dbPath, openAppDatabase, sessionId) {
  const db = openAppDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`INSERT INTO investigation_runs
        (id, session_id, prompt, status, stop_reason, model_provider, model_id, tool_mode, created_at)
        VALUES (?, ?, 'CLI tools smoke', 'completed', 'completed', 'mock', 'smoke', 'mock', ?)
      `).run(runId, sessionId, now);
      db.prepare(`INSERT INTO run_events (run_id, seq, event_type, payload_json, created_at)
        VALUES (?, 1, 'agent_end', '{}', ?)`).run(runId, now);
    })();
  } finally {
    db.close();
  }
}

function checkCascade(dbPath, openAppDatabase) {
  const db = openAppDatabase(dbPath);
  try {
    for (const table of ['sessions', 'investigation_runs', 'run_events', 'artifacts']) {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count, 0, table + ' was not cleared.');
    }
  } finally {
    db.close();
  }
}

function toolData(result, name) {
  const data = JSON.parse(result.content);
  if (result.isError) throw new Error(name + ' failed (' + (data.error?.code ?? 'TOOL_FAILED') + ').');
  return data;
}

async function readArtifact(app, id) {
  const response = await app.inject('/api/artifacts/' + id + '?offsetLine=1&limit=50');
  assert.equal(response.statusCode, 200, 'Artifact HTTP readback failed.');
  const { artifact, slice } = response.json();
  return { artifact: ArtifactMetaSchema.parse(artifact), slice: TextSliceResponseSchema.parse(slice) };
}

async function structuredResult(app, result, name) {
  const data = toolData(result, name);
  if (!result.artifactId) return data;
  const { slice } = await readArtifact(app, result.artifactId);
  assert.equal(slice.totalLines, 1, name + ' Artifact must contain a single JSON line.');
  return JSON.parse(slice.lines[0].text);
}

async function checkArtifact(app, call, output, content, artifactSource) {
  const summary = toolData(output, 'Artifact offload');
  const summaryBytes = Buffer.byteLength(output.content);
  const rawBytes = Buffer.byteLength(content);
  assert.ok(output.artifactId && summaryBytes <= limit && rawBytes > limit, 'Artifact byte budgets were not met.');
  assert.equal(summary.artifactId, output.artifactId);
  assert.equal(output.summary?.truncatedForLlm, true);

  const { artifact, slice } = await readArtifact(app, output.artifactId);
  assert.equal(artifact.byteSize, rawBytes);
  assert.equal(slice.lines.map((line) => line.text).join('\n'), content, 'HTTP did not return the original tool output.');
  let startLine = 1;
  if (artifactSource === 'search_logs') {
    const result = await call('read_artifact_slice', { artifactId: artifact.id, startLine, limit: 50 });
    const data = toolData(result, 'read_artifact_slice');
    const bounded = TextSliceResponseSchema.parse(data);
    assert.equal(data.lineTruncated, true);
    assert.equal(bounded.totalLines, 1);
    assert.equal(bounded.lines[0]?.lineNumber, 1);
    assert.ok(bounded.lines[0].text && content.startsWith(bounded.lines[0].text));
    assert.ok(Buffer.byteLength(result.content) <= limit);
  } else {
    const lines = [];
    do {
      const result = await call('read_artifact_slice', { artifactId: artifact.id, startLine, limit: 50 });
      const data = toolData(result, 'read_artifact_slice');
      const page = TextSliceResponseSchema.parse(data);
      assert.ok(!data.lineTruncated && Buffer.byteLength(result.content) <= limit);
      assert.ok(page.nextOffsetLine === null || page.nextOffsetLine > startLine);
      lines.push(...page.lines);
      startLine = page.nextOffsetLine;
    } while (startLine !== null);
    assert.deepEqual(lines, slice.lines, 'Tool pages did not return the original multiline Artifact.');
  }
  return { artifactId: artifact.id, summaryBytes, rawBytes, slice };
}

async function runSmoke(app, { dbPath, openAppDatabase, createServerTraceWorkspace, root, allowedRoots, path }) {
  const targetPath = path ?? defaultPath;
  const browse = await app.inject('/api/fs/browse?' + new URLSearchParams({ path: targetPath }));
  assert.equal(browse.statusCode, 200, 'Directory browse failed: ' + browse.json().error?.code);
  FsBrowseResponseSchema.parse(browse.json());
  const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath } });
  assert.equal(created.statusCode, 201, 'Session creation failed.');
  const session = SessionSchema.parse(created.json());
  assert.equal(session.pathType, 'dir');
  seedRun(dbPath, openAppDatabase, session.id);

  const { artifactStore } = app;
  const workspace = createServerTraceWorkspace(session, { baseDir: root });
  const ctx = {
    runId, sessionId: session.id, targetPath: session.targetPath, allowedRoots, toolMode: 'mock',
    artifactStore, signal: new AbortController().signal,
  };
  let rawSearch;
  const observed = createToolRegistry({ toolMode: 'mock', artifactStore, workspace }).map((tool) => (
    tool.name !== 'search_logs' ? tool : {
      ...tool,
      async execute(args, context) {
        rawSearch = await tool.execute(args, context);
        return rawSearch;
      },
    }
  ));
  const wrapped = wrapToolsWithArtifactOffload(observed);
  function call(name, args) {
    const tool = wrapped.find((candidate) => candidate.name === name);
    assert.ok(tool, 'Missing tool ' + name);
    return tool.execute(args, { ...ctx, toolCallId: 'tc_smoke_' + name });
  }

  const listed = await structuredResult(app, await call('list_files', { maxFiles: 20 }), 'list_files');
  assert.ok(Array.isArray(listed.files) && listed.files.length > 0, 'The directory has no supported trace files.');
  const inspectedFile = path === undefined ? defaultLog : listed.files[0].path;
  TraceOverviewSchema.parse(await structuredResult(app, await call('inspect_trace', { file: inspectedFile }), 'inspect_trace'));

  let output = await call('search_logs', path === undefined ? { query: 'INFO', file: defaultLog } : { query: 'INFO' });
  toolData(output, 'search_logs');
  let content = rawSearch.content;
  let artifactSource = 'search_logs';
  if (Buffer.byteLength(content) <= limit && path !== undefined) {
    artifactSource = 'synthetic_fallback';
    content = Array.from({ length: 24 }, (_, index) => 'INFO fallback ' + index + ' ' + '中'.repeat(100)).join('\n');
    output = await offloadOversizedToolOutput({ content, isError: false }, {
      runId, sessionId: session.id, toolCallId: 'tc_smoke_fallback', sourceTool: 'tools-smoke',
      title: 'Synthetic fallback for a small search result',
    }, artifactStore);
  }
  const { artifactId, summaryBytes, rawBytes, slice } = await checkArtifact(app, call, output, content, artifactSource);
  let hit;
  if (artifactSource === 'search_logs') {
    const { matches } = JSON.parse(slice.lines[0].text);
    hit = matches[0];
    assert.ok(hit && Number.isSafeInteger(hit.lineNumber) && hit.lineNumber > 0, 'Search did not provide a source coordinate.');
  }
  const sourceFile = hit?.file ?? inspectedFile;
  const sourceLine = hit?.lineNumber ?? null;
  const original = workspace.readFile(sourceFile, allowedRoots);
  if (hit) {
    const query = new URLSearchParams({ file: sourceFile, startLine: String(sourceLine), limit: '5' });
    const response = await app.inject('/api/sessions/' + session.id + '/file-slice?' + query);
    assert.equal(response.statusCode, 200, 'Source file slice failed.');
    const first = TextSliceResponseSchema.parse(response.json()).lines[0];
    assert.equal(first?.lineNumber, sourceLine);
    const request = { offsetLine: sourceLine, limit: 1 };
    assert.equal(first.text, workspace.sliceText(original.content, request).lines[0]?.text);
    const visible = sanitizeTraceContent(original.content, sourceFile);
    assert.ok(visible.ok, 'Source line could not be compared with the search result.');
    const matchLine = workspace.sliceText(visible.sanitized, request).lines[0]?.text;
    assert.ok(typeof hit.text === 'string' && hit.text && matchLine?.startsWith(hit.text), 'Search preview did not match its source line.');
  }

  const deleted = await app.inject({ method: 'DELETE', url: '/api/sessions/' + session.id });
  assert.equal(deleted.statusCode, 200, 'Session deletion failed.');
  const missing = await app.inject('/api/artifacts/' + artifactId);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, 'ARTIFACT_NOT_FOUND');
  checkCascade(dbPath, openAppDatabase);
  assert.deepEqual(workspace.readFile(sourceFile, allowedRoots), original, 'Source file changed after session deletion.');
  return { ok: true, artifactSource, artifactId, summaryBytes, rawBytes, sourceFile, sourceLine, cascadeCleared: true };
}

export async function runToolsSmoke(root, path) {
  const { buildApp } = await tsImport('../../apps/server/src/app.ts', import.meta.url);
  const { openAppDatabase } = await tsImport('../../apps/server/src/db/database.ts', import.meta.url);
  const { createServerTraceWorkspace } = await tsImport('../../apps/server/src/fs/trace-workspace.ts', import.meta.url);
  const { DEFAULT_ALLOWED_TRACE_ROOTS, splitAllowedTraceRoots } =
    await tsImport('../../apps/server/src/config/env.ts', import.meta.url);
  const allowedRoots = splitAllowedTraceRoots(process.env.ALLOWED_TRACE_ROOTS ?? DEFAULT_ALLOWED_TRACE_ROOTS);
  const parent = realpathSync.native(tmpdir());
  const temp = mkdtempSync(join(parent, 'mini-agent-run-tools-smoke-'));
  if (dirname(temp) !== parent) throw new Error('Unexpected temporary database directory.');
  const dbPath = join(temp, 'smoke.db');
  try {
    const app = buildApp({ allowedTraceRoots: allowedRoots, baseDir: root, dbPath });
    try {
      return await runSmoke(app, { dbPath, openAppDatabase, createServerTraceWorkspace, root, allowedRoots, path });
    } finally {
      await app.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
