import { createMockLLMProvider, LLMProviderError, type LLMProvider } from '@mini-agent-run/ai';
import { InvestigationRunSchema, RunEventEnvelopeSchema, SessionSchema, type RunEventEnvelope } from '@mini-agent-run/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import { openAppDatabase } from '../src/db/database.js';
import { createSqliteRunStore } from '../src/db/run-repository.js';
import { startServer } from '../src/start-server.js';

const fixture = './data/fixtures/diagnostic-demo';

async function createFixtureSession(app: ReturnType<typeof buildApp>, targetPath = fixture) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath } });
  expect(response.statusCode).toBe(201);
  return SessionSchema.parse(response.json());
}

async function start(app: ReturnType<typeof buildApp>, sessionId: string, prompt = 'Investigate this trace') {
  const response = await app.inject({ method: 'POST', url: '/api/sessions/' + sessionId + '/runs', payload: { prompt } });
  expect(response.statusCode).toBe(201);
  return InvestigationRunSchema.parse(response.json());
}

async function withApp(options: BuildAppOptions, test: (app: ReturnType<typeof buildApp>) => Promise<void>) {
  const app = buildApp(options);
  try { await test(app); } finally { await app.close(); }
}

function parseFrames(body: string) {
  return body.split('\n\n').filter((frame) => frame.startsWith('id: ')).map((frame) => {
    const [id, type, data] = frame.split('\n');
    const parsed = RunEventEnvelopeSchema.parse(JSON.parse(data?.slice(6) ?? 'null'));
    expect(id).toBe('id: ' + parsed.seq);
    expect(type).toBe('event: ' + parsed.event.type);
    return parsed;
  });
}

async function runDetail(app: ReturnType<typeof buildApp>, id: string) {
  const response = await app.inject('/api/runs/' + id);
  expect(response.statusCode).toBe(200);
  const { run, events } = response.json();
  return { run: InvestigationRunSchema.parse(run), events: RunEventEnvelopeSchema.array().parse(events) };
}

async function settle(app: ReturnType<typeof buildApp>, id: string) {
  const response = await app.inject('/api/runs/' + id + '/stream');
  expect(response.statusCode).toBe(200);
  const detail = await runDetail(app, id);
  expect(parseFrames(response.body)).toEqual(detail.events);
  expect(detail.events.at(-1)?.event.type).toBe('agent_end');
  return detail;
}

async function withTemporaryDatabase(test: (directory: string, dbPath: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'm23-runs-'));
  try { await test(directory, join(directory, 'runs.db')); } finally { rmSync(directory, { recursive: true, force: true }); }
}

const failure = new LLMProviderError('LLM_UPSTREAM_ERROR', 'Fixture failure.');
const failedPrompt = 'Prompt from a failed run.';
const stoppedPrompt = 'Prompt from a stopped run.';

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { id: 'tc_' + name, name, arguments: args };
}

function providerResponse(...chunks: object[]) {
  return new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('M2.3 Run HTTP and SSE', () => {
  it('F05_MULTI_TURN_INVESTIGATION writes coalesced text, evidence, and completed-only conversation history', async () => {
    const answer = 'The fixture shows an error. ' + 'Observed evidence. '.repeat(20) + 'End.';
    const conclusion = { summary: 'Observed log evidence', recommendations: [], evidence: [] };
    const fence = String.fromCharCode(96).repeat(3);
    const raw = answer + '\n\n' + fence + 'investigation-conclusion\n' + JSON.stringify(conclusion) + '\n' + fence;
    const provider = createMockLLMProvider({ turns: [
      { toolCalls: [toolCall('inspect_trace', { file: 'agent-run-failed.jsonl' })] },
      { toolCalls: [toolCall('search_logs', { file: 'noisy-large-xss.log', query: 'INFO' })] },
      { text: raw, chunkSize: 3 },
      { error: failure },
      { text: 'Follow-up completed.' },
    ] });
    await withApp({ llmProvider: provider, coalesceWindowMs: 15, coalesceMaxChars: 256 }, async (app) => {
      const session = await createFixtureSession(app);
      const run = await start(app, session.id, 'Initial investigation');
      expect(run).toMatchObject({ status: 'pending', lastSeq: 0 });
      const detail = await settle(app, run.id);
      expect(detail.run).toMatchObject({ finalAnswer: answer, conclusion, status: 'completed', stepCount: 3 });
      expect(detail.events.map(({ seq }) => seq)).toEqual(detail.events.map((_, index) => index + 1));
      expect(detail.events.at(-1)?.event).toMatchObject({ finalAnswer: answer, conclusion });
      const toolEvents = detail.events.flatMap(({ event }) => event.type === 'tool_execution_end' ? [event] : []);
      expect(toolEvents.map(({ toolName, isError }) => [toolName, isError]))
        .toEqual([['inspect_trace', false], ['search_logs', false]]);
      const artifactId = toolEvents[1]?.artifactId;
      const artifact = await app.inject('/api/artifacts/' + artifactId + '?limit=1');
      expect(artifact.statusCode).toBe(200);
      expect(artifact.json()).toMatchObject({ artifact: { id: artifactId, runId: run.id, sourceTool: 'search_logs' } });
      const deltas = detail.events.flatMap(({ event }) =>
        event.type === 'message_update' && event.deltaType === 'text_delta' ? [event.delta] : []);
      expect(deltas).toHaveLength(2);
      expect(deltas[0]?.length).toBeGreaterThanOrEqual(256);
      expect(deltas.join('')).toBe(raw);
      const end = detail.events.findIndex(({ event }) => event.type === 'message_end' && event.message.content === raw);
      expect(detail.events[end - 1]?.event).toMatchObject({ type: 'message_update', delta: deltas[1] });
      expect(provider.recordedRequests[0]?.tools).toHaveLength(7);
      expect(provider.recordedRequests[0]?.messages[0]?.content).not.toContain(session.targetPath);

      const failed = await start(app, session.id, failedPrompt);
      expect((await settle(app, failed.id)).run.status).toBe('failed');
      const stopped = app.runCoordinator.startRun(session.id, { prompt: stoppedPrompt });
      app.runCoordinator.stopRun(stopped.id);
      expect((await settle(app, stopped.id)).run.status).toBe('stopped');
      const followUp = await start(app, session.id, 'What should I do next?');
      await settle(app, followUp.id);
      const history = provider.recordedRequests.at(-1)?.messages.map(({ content }) => content).join('\n');
      expect(history).toContain('Initial investigation');
      expect(history).toContain(answer);
      expect(history).toContain('What should I do next?');
      expect(history).not.toContain(failedPrompt);
      expect(history).not.toContain(stoppedPrompt);
    });
  });

  it('uses the request key once and redacts both keys from SQLite, HTTP, SSE and provider errors', async () => {
    const original = 'fixture-' + 'original-private';
    const override = 'fixture-' + 'override-private';
    await withTemporaryDatabase(async (directory, dbPath) => {
      const file = join(directory, 'trace.log');
      const line = 'INFO ' + original + ' ' + override + ' ' + 'X'.repeat(200);
      writeFileSync(file, Array.from({ length: 49 }, () => line).join('\n'));
      const authorizations: Array<string | null> = [];
      const stub = vi.fn<typeof fetch>(async (_url, init) => {
        const authorization = new Headers(init?.headers).get('authorization');
        authorizations.push(authorization);
        const { messages } = JSON.parse(String(init?.body));
        if (messages.at(-1)?.content === 'Error probe') return new Response('Upstream echoed ' + override, { status: 401 });
        if (authorization === 'Bearer ' + override && !messages.some(({ role }: { role: string }) => role === 'tool')) {
          return providerResponse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc_search', function: {
            name: 'search_logs', arguments: JSON.stringify({ query: 'INFO' }),
          } }] }, finish_reason: 'tool_calls' }] });
        }
        const value = authorization === 'Bearer ' + original ? original : override;
        return providerResponse(
          { choices: [{ delta: { content: value.slice(0, 8) }, finish_reason: null }] },
          { choices: [{ delta: { content: value.slice(8) }, finish_reason: 'stop' }] },
        );
      });
      await withApp({
        allowedTraceRoots: [directory], dbPath, llmFetch: stub, coalesceMaxChars: 4,
        llmConfig: { baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: original },
      }, async (app) => {
        const session = await createFixtureSession(app, file);
        const url = '/api/sessions/' + session.id + '/runs';
        const responses: string[] = [];
        for (const [prompt, key] of [['Default probe ' + original, undefined], ['Override probe ' + override, override],
          ['Error probe', override], ['Default again', undefined]] as const) {
          const created = await app.inject({ method: 'POST', url, payload: { prompt },
            ...(key ? { headers: { 'x-llm-api-key': key } } : {}) });
          expect(created.statusCode).toBe(201);
          responses.push(created.body);
          const { id } = InvestigationRunSchema.parse(created.json());
          const detail = await settle(app, id);
          responses.push((await app.inject('/api/runs/' + id + '/stream')).body, JSON.stringify(detail));
          if (prompt === 'Error probe') expect(detail.run).toMatchObject({ status: 'failed', errorCode: 'LLM_AUTH_ERROR' });
          else expect(detail.run.finalAnswer).toBe('[REDACTED]');
          for (const { event } of detail.events) {
            if (event.type !== 'tool_execution_end' || !event.artifactId) continue;
            const response = await app.inject('/api/artifacts/' + event.artifactId);
            expect(response.statusCode).toBe(200);
            responses.push(response.body);
          }
        }
        expect(authorizations).toEqual([original, override, override, override, original].map((key) => 'Bearer ' + key));
        const readback = openAppDatabase(dbPath);
        try {
          for (const table of ['sessions', 'investigation_runs', 'run_events', 'artifacts']) {
            const rows = readback.prepare('SELECT * FROM ' + table).all();
            expect(rows.length).toBeGreaterThan(0);
            responses.push(JSON.stringify(rows));
          }
        } finally { readback.close(); }
        for (const response of responses) {
          expect(response).not.toContain(original);
          expect(response).not.toContain(override);
        }
      });
    });
  });

  it('F07_RUN_RETRY inherits the source input and caps three retries across chains and branches', async () => {
    const provider = createMockLLMProvider({ turns: ({ messages }) => {
      const prompt = messages.at(-1)?.content;
      if (prompt === 'Complete') return { text: 'Done' };
      if (prompt === 'New issue') return { toolCalls: [toolCall('list_files')] };
      return { error: failure };
    } });
    await withApp({ llmProvider: provider }, async (app) => {
      const session = await createFixtureSession(app);
      const root = await start(app, session.id, 'Original issue');
      const retry = (source: string, payload?: object) => app.inject({
        method: 'POST', url: '/api/runs/' + source + '/retry',
        ...(payload ? { payload } : { headers: { 'content-type': 'application/json', 'content-length': '0' } }),
      });
      await settle(app, root.id);
      async function rerun(source: string, status: 'failed' | 'stopped', payload?: object) {
        const response = await retry(source, payload);
        expect(response.statusCode).toBe(201);
        const run = InvestigationRunSchema.parse(response.json());
        expect(run.retryOfRunId).toBe(source);
        expect((await settle(app, run.id)).run.status).toBe(status);
        return run;
      }
      const a = await rerun(root.id, 'failed', {});
      expect(a).toMatchObject({ prompt: root.prompt, maxSteps: root.maxSteps });
      const b = await rerun(a.id, 'stopped', { prompt: 'New issue', maxSteps: 1 });
      expect(b).toMatchObject({ prompt: 'New issue', maxSteps: 1 });
      await rerun(root.id, 'failed');
      const over = await retry(b.id, {});
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ error: { code: 'RETRY_LIMIT_EXCEEDED' } });
      const completed = await start(app, session.id, 'Complete');
      await settle(app, completed.id);
      const forbidden = await retry(completed.id);
      expect(forbidden.statusCode).toBe(409);
      expect(forbidden.json()).toMatchObject({ error: { code: 'RUN_NOT_RETRYABLE' } });
      const stoppedRoot = app.runCoordinator.startRun(session.id, { prompt: 'Stopped root' });
      app.runCoordinator.stopRun(stoppedRoot.id);
      await settle(app, stoppedRoot.id);
      expect(await rerun(stoppedRoot.id, 'failed')).toMatchObject({ prompt: stoppedRoot.prompt });
    });
  });

  it('F06_RUN_STOP_AND_INVARIANTS stops a real running tool, rejects active collisions and closes SSE on shutdown', async () => {
    const provider = createMockLLMProvider({ turns: () => ({
      toolCalls: [toolCall('check_runtime_diagnostics', { delayMs: 400, progressIntervalMs: 5 })],
    }) });
    await withTemporaryDatabase(async (_directory, dbPath) => {
      const app = buildApp({ dbPath, llmProvider: provider, sseHeartbeatMs: 10 });
      let shutdown = false;
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const session = await createFixtureSession(app);
        const run = await start(app, session.id);
        await expect.poll(async () => (await runDetail(app, run.id)).events.some(({ event }) =>
          event.type === 'tool_execution_update'), { interval: 5 }).toBe(true);
        const duplicate = await app.inject({ method: 'POST', url: '/api/sessions/' + session.id + '/runs',
          payload: { prompt: 'Duplicate' } });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toMatchObject({ error: { code: 'SESSION_HAS_ACTIVE_RUN' } });
        const retry = await app.inject({ method: 'POST', url: '/api/runs/' + run.id + '/retry' });
        expect(retry.statusCode).toBe(409);
        expect(retry.json()).toMatchObject({ error: { code: 'RUN_STILL_ACTIVE' } });
        const stop = () => app.inject({ method: 'POST', url: '/api/runs/' + run.id + '/stop' });
        const requested = await stop();
        expect(requested.statusCode).toBe(202);
        expect(requested.json()).toEqual({ runId: run.id, status: 'stopping' });
        const stopped = await settle(app, run.id);
        expect(stopped.run).toMatchObject({ status: 'stopped', stopReason: 'user_abort' });
        expect(stopped.events.filter(({ event }) => event.type === 'agent_end')).toHaveLength(1);
        expect((await stop()).json()).toEqual({ runId: run.id, status: 'stopped', alreadyTerminal: true });
        expect((await runDetail(app, run.id)).run).toEqual(stopped.run);

        const pending = app.runCoordinator.startRun(session.id, { prompt: 'Cancel before background execution' });
        const pendingStop = await app.inject({ method: 'POST', url: '/api/runs/' + pending.id + '/stop' });
        expect(pendingStop.statusCode).toBe(202);
        expect((await settle(app, pending.id)).run).toMatchObject({ status: 'stopped', startedAt: null });

        const active = await start(app, session.id, 'Close the server with this run');
        const stream = await fetch(address + '/api/runs/' + active.id + '/stream');
        const close = app.close();
        const frames = parseFrames(await stream.text());
        await close;
        shutdown = true;
        expect(frames.at(-1)?.event).toMatchObject({ type: 'agent_end', status: 'stopped' });
        expect(app.runCoordinator.activeRunCount).toBe(0);
        expect(app.runCoordinator.subscriberCount).toBe(0);
        const db = openAppDatabase(dbPath);
        try { expect(createSqliteRunStore(db).getRun(active.id)).toMatchObject({ status: 'stopped' }); } finally { db.close(); }
      } finally {
        if (!shutdown) await app.close();
      }
    });
  });

  it('F08_HISTORY_REPLAY_AND_RESUME retains durable events and appends one terminal frame during takeover', async () =>
    withTemporaryDatabase(async (_directory, dbPath) => {
      let runId = '';
      await withApp({ dbPath }, async (app) => {
        const session = await createFixtureSession(app);
        const db = openAppDatabase(dbPath);
        try {
          const store = createSqliteRunStore(db);
          const run = store.createRun({
            sessionId: session.id, prompt: 'Interrupted history', modelId: 'fixture', modelProvider: 'fixture',
            toolMode: 'mock', maxSteps: 12,
          });
          runId = run.id;
          store.markRunning(run.id, new Date().toISOString());
          store.appendEvents(run.id, [{ type: 'turn_start', step: 1 }]);
        } finally { db.close(); }
      });
      const { app } = await startServer({ dbPath, port: 0 });
      try {
        const historical = await settle(app, runId);
        expect(historical.run).toMatchObject({ status: 'failed', stopReason: 'server_restarted', errorCode: 'SERVER_RESTARTED' });
        expect(historical.events.map(({ seq, event }) => [seq, event.type])).toEqual([[1, 'turn_start'], [2, 'agent_end']]);
        expect(app.recoverStaleRuns()).toBe(0);
        const session = await app.inject('/api/sessions/' + historical.run.sessionId);
        expect(session.json()).toMatchObject({ hasActiveRun: false, runs: [historical.run] });
      } finally { await app.close(); }
    }));

  it('validates headers, request bodies, cursor and long IDs and creates no Run without a provider', async () =>
    withApp({}, async (app) => {
      const session = await createFixtureSession(app);
      const url = '/api/sessions/' + session.id + '/runs';
      const unavailable = await app.inject({ method: 'POST', url, payload: { prompt: 'Investigate' } });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ error: { code: 'LLM_NOT_CONFIGURED' } });
      const duplicated = await app.inject({ method: 'POST', url, payload: { prompt: 'Investigate' },
        headers: { 'x-llm-api-key': ['first', 'second'] } });
      expect(duplicated.statusCode).toBe(400);
      const malformed = await app.inject({ method: 'POST', url, payload: '{',
        headers: { 'content-type': 'application/json' } });
      expect(malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      const detail = await app.inject('/api/sessions/' + session.id);
      expect(detail.json()).toMatchObject({ runs: [], hasActiveRun: false });
      for (const suffix of ['', '/stream', '/stop', '/retry']) {
        const method = suffix === '/stop' || suffix === '/retry' ? 'POST' : 'GET';
        const missing = await app.inject({ method, url: '/api/runs/run_' + 'a'.repeat(130) + suffix });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
        const invalid = await app.inject({ method, url: '/api/runs/bad_' + 'a'.repeat(130) + suffix });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      }
      for (const cursor of ['-1', '1.1', '9007199254740992', '1&afterSeq=2']) {
        const invalid = await app.inject('/api/runs/run_unknown/stream?afterSeq=' + cursor);
        expect(invalid.statusCode).toBe(400);
      }
    }));

  it('F08_HISTORY_REPLAY_AND_RESUME streams on a real socket, sends heartbeats and resumes after disconnect', async () => {
    const resume = Promise.withResolvers<void>();
    const provider: LLMProvider = {
      name: 'fixture',
      async *stream() {
        yield { type: 'text_delta', delta: 'Starting.' };
        await resume.promise;
        yield { type: 'text_delta', delta: ' Done.' };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    await withApp({ llmProvider: provider, sseHeartbeatMs: 10, coalesceWindowMs: 5 }, async (app) => {
      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const session = await createFixtureSession(app);
      const run = await start(app, session.id);
      const url = '/api/runs/' + run.id + '/stream';
      const abort = new AbortController();
      const first = await fetch(address + url, { signal: abort.signal });
      expect(first.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(first.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(first.headers.get('x-accel-buffering')).toBe('no');
      const reader = first.body?.getReader();
      if (!reader) throw new Error('Expected SSE body.');
      const decoder = new TextDecoder();
      let received = '';
      try {
        while (!received.includes(': ping\n\n') || !received.includes('Starting.')) {
          const part = await reader.read();
          if (part.done) break;
          received += decoder.decode(part.value, { stream: true });
        }
        expect(received).toContain(': ping\n\n');
        expect(received).toContain('Starting.');
      } finally {
        abort.abort();
        await reader.cancel().catch(() => {});
      }
      const firstFrames = parseFrames(received.slice(0, received.lastIndexOf('\n\n') + 2));
      const last = firstFrames.at(-1)?.seq ?? 0;
      expect(last).toBeGreaterThan(0);
      await expect.poll(() => app.runCoordinator.subscriberCount, { interval: 5 }).toBe(0);
      const resumed = await fetch(address + url + '?afterSeq=0', { headers: { 'last-event-id': String(last) } });
      resume.resolve();
      const replayed = parseFrames(await resumed.text());
      const detail = await app.inject('/api/runs/' + run.id);
      const events: RunEventEnvelope[] = detail.json().events;
      expect([...firstFrames, ...replayed]).toEqual(events);
      expect(events.at(-1)?.event.type).toBe('agent_end');
      const after = await app.inject(url + '?afterSeq=' + last);
      expect(parseFrames(after.body)).toEqual(replayed);
      expect((await app.inject(url + '?afterSeq=9007199254740991')).body).toBe('');
    });
  });
});
