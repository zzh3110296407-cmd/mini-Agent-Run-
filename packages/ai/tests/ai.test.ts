import {
  createMockLLMProvider, createOpenAICompatibleProvider, LLMProviderError, normalizeToolCallId,
  parseSseByteStream, resolveChatCompletionsUrl, type LLMGenerateRequest,
} from '@mini-agent-run/ai';
import { ToolCallIdSchema } from '@mini-agent-run/shared';
import fc from 'fast-check';
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const model = 'fixture-model';
const baseUrl = 'https://example.invalid';
const apiKey = ['sk', 'test-fixture-0123456789'].join('-');
const request: LLMGenerateRequest = { model, messages: [{ role: 'user', content: 'Inspect the trace.' }] };
const encoder = new TextEncoder();

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function byteStream(text: string, chunkSizes = [1]): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let start = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (start === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, start + (chunkSizes[index++ % chunkSizes.length] ?? 1));
      controller.enqueue(bytes.subarray(start, end));
      start = end;
    },
  });
}

const event = (delta: object, finish: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + '\n\n';
const done = 'data:[DONE]\n\n';

function providerFor(text: string) {
  return createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl: async () => new Response(byteStream(text, [1, 5, 3])) });
}

const call = { id: 'tc_fixture', name: 'inspect_trace', arguments: { file: 'trace.json' } };
const randomText = fc.array(fc.constantFrom('a', '中', '🙂', '𠮷', ' ', ':', '\n', '"', '\\'), {
  maxLength: 12,
}).map((points) => points.join(''));

describe('[F05_MULTI_TURN_INVESTIGATION] OpenAI-compatible model gateway', () => {
  it.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://example.invalid/v1', baseUrl + '/v1/chat/completions'],
    ['https://example.invalid/v1///', baseUrl + '/v1/chat/completions'],
    ['https://example.invalid/proxy/chat/completions/', baseUrl + '/proxy/chat/completions'],
    ['http://localhost:3000/prefix?tenant=demo', 'http://localhost:3000/prefix/v1/chat/completions?tenant=demo'],
  ])('normalizes endpoint %s', (input, output) => {
    expect(resolveChatCompletionsUrl(input)).toBe(output);
  });

  it('rejects invalid URLs and protocols without echoing the address', () => {
    for (const input of ['file:///secret', 'invalid address']) {
      expect(() => resolveChatCompletionsUrl(input)).toThrow(expect.objectContaining({ code: 'LLM_BAD_REQUEST' }));
    }
  });

  it('decodes split UTF-8, comments, CRLF and multiline SSE data and flushes the last event', async () => {
    const stream = byteStream(': heartbeat\r\ndata: 中文🙂\r\ndata:second\r\n\r\ndata:尾部𠮷');
    expect(await collect(parseSseByteStream(stream))).toEqual(['中文🙂\nsecond', '尾部𠮷']);
    expect(stream.locked).toBe(false);
    expect(await collect(providerFor(event({ content: '中文🙂𠮷' }) + done).stream(request))).toEqual([
      { type: 'text_delta', delta: '中文🙂𠮷' }, { type: 'done', stopReason: 'stop' },
    ]);
    expect(await collect(providerFor(event({ content: 'final' }, 'stop').trimEnd()).stream(request))).toEqual([
      { type: 'text_delta', delta: 'final' }, { type: 'done', stopReason: 'stop' },
    ]);
  });

  it('assembles interleaved calls by index and uses their normalized IDs in the next request', async () => {
    const prefix = 'call_' + 'same-id-prefix-'.repeat(10);
    const wire = event({ tool_calls: [
      { index: 1, id: prefix + 'second', function: { name: 'search_', arguments: '{"q":' } },
      { index: 0, id: prefix + 'first', function: { name: 'inspect_', arguments: '{"file":' } },
    ] }) + event({ tool_calls: [
      { index: 0, function: { name: 'trace', arguments: '"轨迹🙂.json"}' } },
      { index: 1, function: { name: 'logs', arguments: '"ERROR"}' } },
    ] }, 'tool_calls') + done;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(byteStream(wire, [3, 17, 5])))
      .mockImplementationOnce(async () => new Response(event({ content: 'complete' }) + done));
    const provider = createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl, providerName: 'deepseek' });
    expect(provider.name).toBe('deepseek');
    const output = await collect(provider.stream(request));
    const calls = output.flatMap((chunk) => chunk.type === 'toolcall_complete' ? [chunk.toolCall] : []);
    expect(calls).toMatchObject([
      { name: 'inspect_trace', arguments: { file: '轨迹🙂.json' } }, { name: 'search_logs', arguments: { q: 'ERROR' } },
    ]);
    const [inspect, search] = calls;
    if (!inspect || !search) throw new Error('Expected both calls.');
    expect(inspect.id).not.toBe(search.id);
    expect(calls.every(({ id }) => ToolCallIdSchema.safeParse(id).success && id.length <= 40)).toBe(true);
    expect(output.filter((chunk) => chunk.type === 'toolcall_delta').map((chunk) => chunk.toolCallId))
      .toEqual([search.id, inspect.id, inspect.id, search.id]);
    expect(output.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });

    await collect(provider.stream({
      model, messages: [
        { role: 'assistant', content: '', toolCalls: calls },
        { role: 'tool', content: 'trace read', name: inspect.name, toolCallId: inspect.id },
      ],
      tools: [{ name: inspect.name, description: 'Read trace', parameters: { type: 'object' } }],
    }));
    const sent = fetchImpl.mock.calls[1]?.[1];
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(baseUrl + '/v1/chat/completions');
    expect(new Headers(sent?.headers).get('Authorization')).toBe('Bearer ' + apiKey);
    expect(JSON.parse(String(sent?.body))).toEqual({
      model, stream: true, messages: [
        { role: 'assistant', content: '', tool_calls: calls.map((tool) => ({
          id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
        })) },
        { role: 'tool', tool_call_id: inspect.id, content: 'trace read' },
      ],
      tools: [{ type: 'function', function: { name: inspect.name, description: 'Read trace', parameters: { type: 'object' } } }],
    });
  });

  it('keeps an emitted ID stable when the upstream ID arrives late and uses early known IDs', async () => {
    const text = event({ tool_calls: [{ index: 0, function: { name: 'inspect' } }, { index: 1, id: 'tc_known' }] })
      + event({ tool_calls: [{ index: 0, id: 'tc_late', function: { arguments: '{}' } },
        { index: 1, function: { name: 'search' } }] }) + done;
    const output = await collect(providerFor(text).stream(request));
    expect(output).toEqual([
      { type: 'toolcall_delta', toolCallId: 'tc_call_0', toolName: 'inspect', argumentsDelta: '' },
      { type: 'toolcall_delta', toolCallId: 'tc_call_0', toolName: 'inspect', argumentsDelta: '{}' },
      { type: 'toolcall_delta', toolCallId: 'tc_known', toolName: 'search', argumentsDelta: '' },
      { type: 'toolcall_complete', toolCall: { id: 'tc_call_0', name: 'inspect', arguments: {} } },
      { type: 'toolcall_complete', toolCall: { id: 'tc_known', name: 'search', arguments: {} } },
      { type: 'done', stopReason: 'tool_calls' },
    ]);
  });

  it.each(['{bad', '[]', 'null', '42'])('rejects invalid tool arguments %s', async (args) => {
    const text = event({ tool_calls: [{ index: 0, function: { name: 'inspect', arguments: args } }] }) + done;
    await expect(collect(providerFor(text).stream(request))).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_ARGUMENTS' });
  });

  it.each([
    event({ content: 'unfinished' }), 'data: {broken\n\n',
    event({ tool_calls: [{ index: -1, function: { name: 'inspect' } }] }) + done,
  ])('rejects truncated and invalid protocol events', async (text) => {
    await expect(collect(providerFor(text).stream(request))).rejects.toMatchObject({ code: 'LLM_PROTOCOL_ERROR' });
  });

  it.each([[401, 'LLM_AUTH_ERROR'], [403, 'LLM_AUTH_ERROR'], [429, 'LLM_RATE_LIMITED'],
    [503, 'LLM_UPSTREAM_ERROR'], [422, 'LLM_BAD_REQUEST']] as const)('maps and redacts HTTP %i', async (status, code) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('reflected ' + apiKey + ' | Authorization: Bearer other-private-token\n'
          + 'a'.repeat(5000) + 'outside-4096'));
      },
      cancel,
    });
    const provider = createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl: async () => new Response(body, { status }) });
    const error: unknown = await collect(provider.stream(request)).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code, statusCode: status });
    expect(String(error)).toContain('[REDACTED]');
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toMatch(/Bearer|other-private-token|outside-4096/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('maps connection failure without including transport exception details', async () => {
    const provider = createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl: async () => { throw new Error(apiKey); } });
    const error: unknown = await collect(provider.stream(request)).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'LLM_NETWORK_ERROR' });
    expect(String(error)).not.toContain(apiKey);
  });

  it('handles pre-abort before fetch and cancels and unlocks the reader on in-flight abort', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(event({ content: 'first' }))); },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
    const provider = createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl });
    await expect(collect(provider.stream({ ...request, signal: stopped.signal }))).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();

    const controller = new AbortController();
    const iterator = provider.stream({ ...request, signal: controller.signal });
    expect(await iterator.next()).toMatchObject({ value: { type: 'text_delta', delta: 'first' } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('times out an unresponsive fetch and removes the source abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const provider = createOpenAICompatibleProvider({ baseUrl, apiKey, fetchImpl, timeoutMs: 10 });
    await expect(collect(provider.stream({ ...request, signal: controller.signal }))).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it.each([
    ['abort', 'LLM_ABORTED'],
    ['timeout', 'LLM_TIMEOUT'],
  ] as const)('cleans up on %s while paused between two tool deltas in the same SSE event', async (mode, code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        sink.enqueue(encoder.encode(event({ tool_calls: [0, 1].map((index) => ({
          index, id: 'call_' + index, function: { name: 'inspect', arguments: '{}' },
        })) })));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body));
    const provider = createOpenAICompatibleProvider({
      baseUrl, apiKey, fetchImpl, timeoutMs: mode === 'timeout' ? 10 : 60_000,
    });
    const iterator = provider.stream({ ...request, signal: controller.signal });
    try {
      expect(await iterator.next()).toMatchObject({ value: { type: 'toolcall_delta', toolCallId: 'tc_call_0' } });
      expect(body.locked).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

      if (mode === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      const paused = {
        transportAborted: fetchImpl.mock.calls[0]?.[1]?.signal?.aborted,
        locked: body.locked,
        cancellations: cancel.mock.calls.length,
        requestTimers: vi.getTimerCount(),
        callerAbortListeners: getEventListeners(controller.signal, 'abort').length,
      };
      const resumed = await iterator.next().then(
        ({ value }) => ({ chunk: value }),
        (error: unknown) => ({ code: error instanceof LLMProviderError ? error.code : undefined }),
      );
      expect({ paused, resumed }).toEqual({
        paused: { transportAborted: true, locked: false, cancellations: 1, requestTimers: 0, callerAbortListeners: 0 },
        resumed: { code },
      });
      expect(await iterator.return(undefined)).toEqual({ done: true, value: undefined });
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    } finally {
      await iterator.return(undefined);
      vi.useRealTimers();
    }
  });

  it('clears request resources when delivering done, before the consumer closes the iterator', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const body = byteStream(done);
    const provider = createOpenAICompatibleProvider({
      baseUrl, apiKey, timeoutMs: 10, fetchImpl: async () => new Response(body),
    });
    const iterator = provider.stream({ ...request, signal: controller.signal });
    try {
      expect(await iterator.next()).toEqual({ done: false, value: { type: 'done', stopReason: 'stop' } });
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
      controller.abort();
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
    } finally {
      await iterator.return(undefined);
      vi.useRealTimers();
    }
  });

  it('reassembles arbitrary UTF-8 byte cuts across 100 seeded SSE sequences', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(randomText, { minLength: 1, maxLength: 4 }), fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 8 }),
      async (values, cuts) => {
        const encoded = values.map((value, index) => (index % 2 ? 'data:' : 'data: ') + JSON.stringify(value)).join('\r\n\r\n');
        const decoded = await collect(parseSseByteStream(byteStream(encoded, cuts)));
        expect(decoded).toEqual(values.map((value) => JSON.stringify(value)));
      },
    ), { seed: 20501, numRuns: 100 });
  });

  it('normalizes arbitrary raw IDs and collisions across 100 seeded rounds', () => {
    fc.assert(fc.property(fc.array(randomText, { maxLength: 10 }), (rawIds) => {
      const used = new Set<string>();
      const prefix = 'call_' + 'x'.repeat(200);
      const originals = ['tc_existing', 'tc_existing', '', prefix + 'a', prefix + 'b', ...rawIds];
      const ids = originals.map((id, index) => normalizeToolCallId(id, index, used));
      expect(ids[0]).toBe('tc_existing');
      expect(ids[3]).not.toBe(ids[4]);
      expect(new Set(ids).size).toBe(originals.length);
      expect(ids.every((id) => id.length <= 40 && ToolCallIdSchema.safeParse(id).success)).toBe(true);
      const fresh = new Set<string>();
      expect(originals.map((id, index) => normalizeToolCallId(id, index, fresh))).toEqual(ids);
    }), { seed: 20502, numRuns: 100 });
  });
});

describe('[F05_MULTI_TURN_INVESTIGATION] deterministic mock model', () => {
  it('scripts successive text, tool and error turns and records each request', async () => {
    const error = new LLMProviderError('LLM_AUTH_ERROR', 'Denied.');
    const mock = createMockLLMProvider({ turns: [
      { text: '中🙂a', chunkSize: 1, toolCalls: [call] }, { text: 'done' }, { error },
    ] });
    expect(await collect(mock.stream(request))).toEqual([
      ...['中', '🙂', 'a'].map((delta) => ({ type: 'text_delta', delta })),
      { type: 'toolcall_complete', toolCall: call }, { type: 'done', stopReason: 'tool_calls' },
    ]);
    expect(await collect(mock.stream(request))).toEqual([{ type: 'text_delta', delta: 'done' }, { type: 'done', stopReason: 'stop' }]);
    await expect(collect(mock.stream(request))).rejects.toBe(error);
    expect(mock.recordedRequests).toEqual([request, request, request]);
  });

  it('passes requests and indexes to the factory and aborts an in-flight mock delay', async () => {
    const controller = new AbortController();
    const turn = vi.fn(() => ({ delayMs: 15, chunks: [{ type: 'text_delta', delta: 'late' }] as const }));
    const mock = createMockLLMProvider({ turns: turn });
    const input = { ...request, signal: controller.signal };
    const pending = collect(mock.stream(input));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LLM_ABORTED' });
    expect(turn).toHaveBeenCalledExactlyOnceWith(input, 0);
    expect(mock.recordedRequests).toEqual([input]);
  });
});
