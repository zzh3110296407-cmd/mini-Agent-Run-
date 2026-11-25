import { ToolCallRequestSchema } from '@mini-agent-run/shared';
import { aborted, ensureActive, releaseReader, whileActive } from './abort.js';
import { LLMProviderError, redactSecret, type LLMErrorCode } from './errors.js';
import type { LLMGenerateRequest, LLMMessage, LLMProvider, LLMStreamChunk } from './index.js';
import { parseSseByteStream } from './sse.js';
import { normalizeToolCallId } from './tool-call-id.js';

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  providerName?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const url = URL.parse(baseUrl);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new LLMProviderError('LLM_BAD_REQUEST', 'The model endpoint must be an HTTP or HTTPS URL.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path
    : path + (path.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions');
  return url.href;
}

function toWireMessage(message: LLMMessage) {
  const { role, content } = message;
  if (role === 'tool') return { role, content, tool_call_id: message.toolCallId };
  if (role === 'assistant' && message.toolCalls?.length) {
    return {
      role, content, tool_calls: message.toolCalls.map(({ id, name, arguments: args }) => ({
        id, type: 'function', function: { name, arguments: JSON.stringify(args) },
      })),
    };
  }
  return { role, content };
}

function statusError(status: number): LLMErrorCode {
  if (status === 401 || status === 403) return 'LLM_AUTH_ERROR';
  if (status === 429) return 'LLM_RATE_LIMITED';
  if (status >= 400 && status < 500) return 'LLM_BAD_REQUEST';
  return 'LLM_UPSTREAM_ERROR';
}

async function readErrorText(body: ReadableStream<Uint8Array> | null, signal: AbortSignal) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let remaining = 4096;
  let text = '';
  try {
    while (remaining > 0) {
      ensureActive(signal);
      const chunk = await whileActive(reader.read(), signal);
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, remaining);
      remaining -= bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await releaseReader(reader, signal);
  }
}

type ToolBuffer = { rawId?: string; id?: string; name: string; arguments: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocol(message: string) {
  return new LLMProviderError('LLM_PROTOCOL_ERROR', message);
}

function decodeEvent(data: string): Record<string, unknown> {
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    throw protocol('The model stream contains invalid JSON.');
  }
  if (!isObject(event) || event.error !== undefined) throw protocol('The model stream contains an invalid event.');
  return event;
}

function appendToolCall(value: unknown, calls: Map<number, ToolBuffer>, used: Set<string>): LLMStreamChunk | undefined {
  if (!isObject(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0) {
    throw protocol('The model stream contains an invalid tool call index.');
  }
  const call = calls.get(value.index) ?? { name: '', arguments: '' };
  calls.set(value.index, call);
  if (typeof value.id === 'string' && value.id) call.rawId ??= value.id;
  if (call.rawId !== undefined) call.id ??= normalizeToolCallId(call.rawId, value.index, used);
  const fn = value.function;
  if (fn === undefined) return;
  if (!isObject(fn) || (fn.name !== undefined && typeof fn.name !== 'string')
      || (fn.arguments !== undefined && typeof fn.arguments !== 'string')) {
    throw protocol('The model stream contains an invalid tool call fragment.');
  }
  const name = typeof fn.name === 'string' ? fn.name : '';
  const args = typeof fn.arguments === 'string' ? fn.arguments : '';
  call.name += name;
  call.arguments += args;
  if (!name && !args) return;
  // Once a delta is visible, its ID also identifies every later delta and the completed call.
  call.id ??= normalizeToolCallId(call.rawId, value.index, used);
  return {
    type: 'toolcall_delta', toolCallId: call.id, argumentsDelta: args,
    ...(call.name.trim() ? { toolName: call.name } : {}),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const args: unknown = raw === '' ? {} : JSON.parse(raw);
    if (isObject(args)) return args;
  } catch {
    // The arguments may contain private data. Do not forward parser details.
  }
  throw new LLMProviderError('LLM_INVALID_TOOL_ARGUMENTS', 'The model tool arguments must be a JSON object.');
}

async function* streamCompletion(
  body: ReadableStream<Uint8Array>, signal: AbortSignal,
): AsyncGenerator<LLMStreamChunk> {
  const calls = new Map<number, ToolBuffer>();
  const used = new Set<string>();
  let finished = false;
  for await (const data of parseSseByteStream(body, signal)) {
    if (data.trim() === '[DONE]') {
      finished = true;
      break;
    }
    const { choices } = decodeEvent(data);
    if (!Array.isArray(choices)) throw protocol('The model stream event has invalid choices.');
    if (choices.length === 0) continue;
    const choice: unknown = choices[0];
    if (!isObject(choice)) throw protocol('The model stream event has an invalid choice.');
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) finished = true;
    const { delta } = choice;
    if (delta === undefined) continue;
    if (!isObject(delta)) throw protocol('The model stream event has an invalid delta.');
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text_delta', delta: delta.content };
    if (delta.tool_calls === undefined) continue;
    if (!Array.isArray(delta.tool_calls)) throw protocol('The model stream contains invalid tool calls.');
    for (const value of delta.tool_calls) {
      const chunk = appendToolCall(value, calls, used);
      if (chunk) yield chunk;
    }
  }
  ensureActive(signal);
  if (!finished) throw protocol('The model stream ended before a completion marker.');
  const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
    const result = ToolCallRequestSchema.safeParse({
      id: call.id ?? normalizeToolCallId(call.rawId, index, used), name: call.name, arguments: parseArguments(call.arguments),
    });
    if (!result.success) throw protocol('The model stream contains incomplete tool call metadata.');
    return result.data;
  });
  for (const toolCall of completed) {
    ensureActive(signal);
    yield { type: 'toolcall_complete', toolCall };
  }
  ensureActive(signal);
  yield { type: 'done', stopReason: completed.length > 0 ? 'tool_calls' : 'stop' };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor({ baseUrl, apiKey, providerName = 'openai-compatible', timeoutMs = 60_000, fetchImpl = fetch }:
    OpenAICompatibleProviderOptions) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      throw new LLMProviderError('LLM_BAD_REQUEST', 'The model request timeout is invalid.');
    }
    this.name = providerName;
    this.#endpoint = resolveChatCompletionsUrl(baseUrl);
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  async *stream({ model, messages, tools, signal }: LLMGenerateRequest): AsyncGenerator<LLMStreamChunk> {
    ensureActive(signal);
    const controller = new AbortController();
    let cancellation: LLMProviderError | undefined;
    const stop = (error: LLMProviderError) => {
      if (!controller.signal.aborted) {
        cancellation = error;
        controller.abort();
      }
    };
    const onAbort = () => stop(aborted());
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new LLMProviderError('LLM_TIMEOUT', 'The model request timed out.')), this.#timeoutMs);
    let response: Response | undefined;
    try {
      let body: string;
      try {
        body = JSON.stringify({
          model, messages: messages.map(toWireMessage),
          ...(tools?.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
          stream: true,
        });
      } catch {
        throw new LLMProviderError('LLM_BAD_REQUEST', 'The model request could not be serialized.');
      }
      response = await whileActive(this.#fetch(this.#endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + this.#apiKey, 'Content-Type': 'application/json' },
        body, signal: controller.signal, redirect: 'manual',
      }), controller.signal);
      ensureActive(controller.signal);
      if (!response.ok) {
        const text = await readErrorText(response.body, controller.signal).catch(() => '');
        ensureActive(controller.signal);
        const detail = redactSecret(text, this.#apiKey).trim();
        throw new LLMProviderError(statusError(response.status),
          `The model endpoint returned HTTP ${response.status}.` + (detail ? ' ' + detail : ''), response.status);
      }
      if (!response.body) throw protocol('The model response has no stream body.');
      yield* streamCompletion(response.body, controller.signal);
    } catch (error) {
      if (cancellation) throw cancellation;
      if (error instanceof LLMProviderError) {
        throw new LLMProviderError(error.code, redactSecret(error.message, this.#apiKey), error.statusCode);
      }
      if (response?.ok) throw protocol('The model response stream was interrupted.');
      throw new LLMProviderError('LLM_NETWORK_ERROR', 'The model endpoint could not be reached.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleProviderOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(options);
}
