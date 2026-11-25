import type { ToolCallRequest } from '@mini-agent-run/shared';
import { setTimeout as delay } from 'node:timers/promises';
import { aborted, ensureActive } from './abort.js';
import { LLMProviderError } from './errors.js';
import type { LLMGenerateRequest, LLMProvider, LLMStreamChunk } from './index.js';

export interface MockLLMTurn {
  chunks?: readonly LLMStreamChunk[];
  text?: string;
  chunkSize?: number;
  toolCalls?: readonly ToolCallRequest[];
  delayMs?: number;
  error?: Error;
}

export interface MockLLMProviderOptions {
  providerName?: string;
  turns: readonly MockLLMTurn[] | ((request: LLMGenerateRequest, callIndex: number) => MockLLMTurn);
}

function* scriptedChunks({ text = '', chunkSize, toolCalls = [], error }: MockLLMTurn): Generator<LLMStreamChunk> {
  const characters = Array.from(text);
  const size = chunkSize ?? Math.max(characters.length, 1);
  if (!Number.isSafeInteger(size) || size < 1) throw new LLMProviderError('LLM_BAD_REQUEST', 'The mock chunk size is invalid.');
  for (let index = 0; index < characters.length; index += size) {
    yield { type: 'text_delta', delta: characters.slice(index, index + size).join('') };
  }
  for (const toolCall of toolCalls) yield { type: 'toolcall_complete', toolCall };
  if (!error) yield { type: 'done', stopReason: toolCalls.length ? 'tool_calls' : 'stop' };
}

export class MockLLMProvider implements LLMProvider {
  readonly name: string;
  readonly #requests: LLMGenerateRequest[] = [];

  constructor(private readonly options: MockLLMProviderOptions) {
    this.name = options.providerName ?? 'mock';
  }

  get recordedRequests(): readonly LLMGenerateRequest[] {
    return this.#requests;
  }

  async *stream(request: LLMGenerateRequest): AsyncGenerator<LLMStreamChunk> {
    const { signal } = request;
    ensureActive(signal);
    const callIndex = this.#requests.push(request) - 1;
    const { turns } = this.options;
    const turn = typeof turns === 'function' ? turns(request, callIndex) : turns[callIndex];
    if (!turn) throw new LLMProviderError('LLM_PROTOCOL_ERROR', 'The mock provider has no scripted turn.');
    for (const chunk of turn.chunks ?? scriptedChunks(turn)) {
      ensureActive(signal);
      if (turn.delayMs && turn.delayMs > 0) {
        try {
          await delay(turn.delayMs, undefined, { signal });
        } catch (error) {
          if (signal?.aborted) throw aborted();
          throw error;
        }
      }
      ensureActive(signal);
      yield chunk;
    }
    ensureActive(signal);
    if (turn.error) throw turn.error;
  }
}

export function createMockLLMProvider(options: MockLLMProviderOptions): MockLLMProvider {
  return new MockLLMProvider(options);
}
