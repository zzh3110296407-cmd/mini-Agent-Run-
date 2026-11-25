import type { LLMProvider } from '@mini-agent-run/ai';
import { InvestigationRunSchema, RunEventEnvelopeSchema, SessionSchema, type RunEventEnvelope } from '@mini-agent-run/shared';
import { describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app.js';

const fixture = './data/fixtures/diagnostic-demo';

async function createFixtureSession(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { targetPath: fixture } });
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

describe('M2.3 Run HTTP and SSE', () => {
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
    await withApp({ llmProvider: provider, sseHeartbeatMs: 10, diagnosticsProgressIntervalMs: 8 }, async (app) => {
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
        while (!received.includes(': ping\n\n')) {
          const part = await reader.read();
          if (part.done) break;
          received += decoder.decode(part.value, { stream: true });
        }
        expect(received).toContain(': ping\n\n');
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
