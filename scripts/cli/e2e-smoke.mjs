import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockLLMProvider, parseSseByteStream } from '@mini-agent-run/ai';
import { MAX_INLINE_TOOL_OUTPUT_BYTES, RunEventEnvelopeSchema } from '@mini-agent-run/shared';
import { tsImport } from 'tsx/esm/api';

export const diagnosticPath = 'data/fixtures/diagnostic-demo';
export const largeLog = 'noisy-large-xss.log';
export const initialPrompt = 'Inspect the diagnostic fixture and explain the first error.';
export const slowPrompt = 'Run the slow diagnostic so I can stop it.';
const followUpPrompt = 'What should I verify next?';
const trace = 'agent-run-failed.jsonl';
const conclusionFence = String.fromCharCode(96).repeat(3);
let serverModule;

function tool(name, args = {}) {
  return { toolCalls: [{ id: 'tc_' + name, name, arguments: args }] };
}

function withConclusion(artifactId) {
  const conclusion = {
    summary: 'The synthetic packet lacks the required sequence field.',
    threeStateAssessment: { terminationReason: 'stop', hasToolError: false, taskOutcome: 'failed' },
    evidence: [
      { kind: 'file_line', file: largeLog, startLine: 1100, label: 'First log error' },
      { kind: 'artifact_line', artifactId, startLine: 1, label: 'Search result' },
    ],
    recommendations: ['Populate the sequence field before sending the packet.'],
  };
  return { text: 'The first error identifies the missing sequence field.\n\n' + conclusionFence +
    'investigation-conclusion\n' + JSON.stringify(conclusion) + '\n' + conclusionFence };
}

export function createOfflineProvider() {
  return createMockLLMProvider({ turns: ({ messages }) => {
    const lastPrompt = messages.findLastIndex(({ role }) => role === 'user');
    const prompt = messages[lastPrompt]?.content;
    const responses = messages.slice(lastPrompt + 1).filter(({ role }) => role === 'tool');
    if (prompt === slowPrompt && responses.length === 0) {
      return tool('check_runtime_diagnostics', { scenario: 'slow', delayMs: 2000, progressIntervalMs: 15 });
    }
    if (prompt === 'Inspect the supplied training trace.') {
      return responses.length ? { text: 'Training trace inspected.' } : tool('inspect_trace');
    }
    const names = responses.map(({ name }) => name);
    if (prompt === followUpPrompt) {
      if (!names.includes('compare_files')) {
        return tool('compare_files', { fileA: trace, fileB: 'agent-run-passed.jsonl' });
      }
      if (!names.includes('read_file_slice')) {
        return tool('read_file_slice', { file: largeLog, startLine: 1100, limit: 1 });
      }
    }
    if (prompt !== initialPrompt) return { text: 'The follow-up can verify the sequence field.' };
    if (!names.includes('list_files')) return tool('list_files');
    if (!names.includes('inspect_trace')) return tool('inspect_trace', { file: trace });
    if (!names.includes('search_logs')) return tool('search_logs', { file: largeLog, query: 'INFO', maxMatches: 60 });
    const search = responses.find(({ name }) => name === 'search_logs');
    const artifactId = search?.content.match(/art_[0-9a-f-]{36}/u)?.[0];
    assert.ok(artifactId, 'search_logs did not return an Artifact pointer');
    if (!names.includes('read_artifact_slice')) return tool('read_artifact_slice', { artifactId, limit: 1 });
    return withConclusion(artifactId);
  } });
}

export async function openOfflineWorkbench(root, { extraRoots = [], provider = createOfflineProvider(), startServer } = {}) {
  const launch = startServer ?? (await (serverModule ??= tsImport('../../apps/server/src/start-server.ts', import.meta.url))).startServer;
  const directory = mkdtempSync(join(tmpdir(), 'mini-run-e2e-'));
  const dbPath = join(directory, 'workbench.db');
  let instance;
  async function start() {
    assert.equal(instance, undefined, 'Workbench already listening');
    instance = await launch({ baseDir: root, dbPath, port: 0,
      allowedTraceRoots: [join(root, diagnosticPath), ...extraRoots], llmProvider: provider,
      toolMode: 'mock', sseHeartbeatMs: 25 });
  }
  async function stop() {
    if (!instance) return;
    const running = instance;
    instance = undefined;
    await running.app.close();
  }
  async function close() {
    try { await stop(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  try {
    await start();
  } catch (error) {
    await close();
    throw error;
  }

  function url(path) {
    assert.ok(instance, 'Workbench is closed');
    return new URL(path, instance.address);
  }
  async function request(path, method = 'GET', body, status = 200) {
    const response = await fetch(url(path), {
      method, signal: AbortSignal.timeout(5000),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(response.status, status, method + ' ' + path + ' returned ' + JSON.stringify(payload?.error ?? null));
    return payload;
  }
  async function* stream(runId, afterSeq = 0) {
    const address = url('/api/runs/' + runId + '/stream');
    if (afterSeq) address.searchParams.set('afterSeq', String(afterSeq));
    const signal = AbortSignal.timeout(5000);
    const response = await fetch(address, { signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream\b/u);
    assert.ok(response.body);
    for await (const data of parseSseByteStream(response.body, signal)) {
      yield RunEventEnvelopeSchema.parse(JSON.parse(data));
    }
  }
  async function end(runId) {
    let last;
    for await (const frame of stream(runId)) last = frame;
    assert.equal(last?.event.type, 'agent_end', 'SSE closed without agent_end');
    return last.event;
  }
  return { dbPath, directory, provider, start, stop, close, request, stream, end, get address() { return instance?.address; } };
}

function sessionUrl(id) { return '/api/sessions/' + id; }
function runUrl(id) { return '/api/runs/' + id; }

export async function runE2eSmoke(root, options) {
  const original = join(root, diagnosticPath, largeLog);
  const originalBytes = readFileSync(original);
  const workbench = await openOfflineWorkbench(root, options);
  const { request, end } = workbench;
  try {
    const directory = await request('/api/sessions', 'POST', { targetPath: diagnosticPath }, 201);
    const file = await request('/api/sessions', 'POST', { targetPath: join(diagnosticPath, 'agent-run-passed.jsonl') }, 201);
    assert.deepEqual(new Set((await request('/api/sessions')).sessions.map(({ id }) => id)), new Set([directory.id, file.id]));
    const start = (prompt) => request(sessionUrl(directory.id) + '/runs', 'POST', { prompt }, 201);
    const initial = await start(initialPrompt);
    const result = await end(initial.id);
    assert.equal(result.status, 'completed');
    assert.ok(result.conclusion?.threeStateAssessment);
    const evidence = result.conclusion.evidence.find(({ kind }) => kind === 'artifact_line');
    assert.ok(evidence);
    const artifactPath = '/api/artifacts/' + evidence.artifactId;
    const artifact = await request(artifactPath + '?limit=1');
    assert.ok(artifact.artifact.byteSize > MAX_INLINE_TOOL_OUTPUT_BYTES);
    assert.ok(JSON.parse(artifact.slice.lines[0].text).matches.length > 0);
    const followUp = await start(followUpPrompt);
    assert.equal((await end(followUp.id)).status, 'completed');
    assert.ok(workbench.provider.recordedRequests.at(-1).messages.some(({ content }) => content === initialPrompt));

    const slow = await start(slowPrompt);
    let stopSent = false;
    let stopped;
    for await (const { event } of workbench.stream(slow.id)) {
      if (event.type === 'tool_execution_update' && !stopSent) {
        await request(runUrl(slow.id) + '/stop', 'POST', {}, 202);
        stopSent = true;
      }
      if (event.type === 'agent_end') stopped = event;
    }
    assert.ok(stopSent, 'No tool progress before stop');
    assert.equal(stopped?.status, 'stopped');
    assert.equal(stopped?.stopReason, 'user_abort');
    const retry = await request(runUrl(slow.id) + '/retry', 'POST', { prompt: 'Verify the diagnostic without delay.' }, 201);
    assert.equal(retry.retryOfRunId, slow.id);
    assert.equal((await end(retry.id)).status, 'completed');

    const history = await request(runUrl(initial.id));
    await workbench.stop();
    await workbench.start();
    assert.deepEqual(await request(runUrl(initial.id)), history);
    assert.deepEqual(await request(artifactPath + '?limit=1'), artifact);
    await request(sessionUrl(directory.id), 'DELETE');
    assert.equal((await request(artifactPath, 'GET', undefined, 404)).error.code, 'ARTIFACT_NOT_FOUND');
    assert.equal((await request(runUrl(initial.id), 'GET', undefined, 404)).error.code, 'RUN_NOT_FOUND');
    assert.equal((await request(sessionUrl(file.id))).session.id, file.id);
    await request(sessionUrl(file.id), 'DELETE');
    assert.deepEqual((await request('/api/sessions')).sessions, []);
    assert.deepEqual(readFileSync(original), originalBytes);
    return { ok: true, sessions: 2, completedRounds: 2, artifactBytes: artifact.artifact.byteSize,
      stopped: true, retried: true, recovered: true, cascadeCleared: true, originalIntact: true };
  } finally {
    await workbench.close();
  }
}
