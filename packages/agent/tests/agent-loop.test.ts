import { projectToLLMMessages, runAgentLoop, type AgentTool, type RunAgentLoopOptions } from '@mini-agent-run/agent';
import { createMockLLMProvider, LLMProviderError, type LLMProvider, type LLMStreamChunk } from '@mini-agent-run/ai';
import { AgentEventSchema, AgentStateSchema, type AgentEvent, type AgentMessage, type ToolCallRequest } from '@mini-agent-run/shared';
import fc from 'fast-check';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

const createdAt = '2026-11-25T00:00:00.000Z';
const artifactStore = {
  save: () => { throw new Error('No artifact save expected.'); },
  getMeta: () => null,
  readSlice: () => null,
};
const summary = {
  byteSize: 7, lineCount: 1, truncatedForLlm: false, levelCounts: { error: 0, warn: 0, info: 0, other: 1 },
  firstErrorLine: null, previewHead: 'preview',
};
const call = (name: string, id = name): ToolCallRequest => ({ id: 'tc_' + id, name, arguments: { input: name } });

function options(provider: LLMProvider, events: AgentEvent[], extra: Partial<RunAgentLoopOptions> = {}): RunAgentLoopOptions {
  return {
    runId: 'run_demo', sessionId: 'ses_demo', prompt: 'Inspect this run.', systemPrompt: 'Use trace evidence.',
    model: { provider: provider.name, modelId: 'fixture-model' }, targetPath: '/fixtures', allowedRoots: ['/fixtures'],
    provider, tools: [], toolMode: 'mock', artifactStore, signal: new AbortController().signal,
    onEvent: (event) => { events.push(event); }, ...extra,
  };
}

function tool(name: string, execute: AgentTool['execute']): AgentTool {
  return { name, description: 'Read ' + name, parameters: { type: 'object' }, execute };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function assertBalanced(events: AgentEvent[]) {
  expect(events[0]?.type).toBe('agent_start');
  expect(events.at(-1)?.type).toBe('agent_end');
  expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
  let assistant: string | undefined;
  let toolCall: string | undefined;
  for (const event of events) {
    expect(AgentEventSchema.safeParse(event).success).toBe(true);
    if (event.type === 'message_start') {
      expect(assistant).toBeUndefined();
      assistant = event.messageId;
    }
    if (event.type === 'message_end') {
      expect(event.message.id).toBe(assistant);
      assistant = undefined;
    }
    if (event.type === 'tool_execution_start') {
      expect(toolCall).toBeUndefined();
      toolCall = event.toolCallId;
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      expect(event.toolCallId).toBe(toolCall);
      if (event.type === 'tool_execution_end') toolCall = undefined;
    }
  }
  expect(assistant).toBeUndefined();
  expect(toolCall).toBeUndefined();
}

describe('[F05_MULTI_TURN_INVESTIGATION] Pi-style agent loop', () => {
  it('projects all roles and includes only the fields used by the model', () => {
    const messages: AgentMessage[] = [
      { id: 'msg_user', role: 'user', content: 'Question', createdAt },
      { id: 'msg_call', role: 'assistant', content: '', toolCalls: [call('inspect')], stopReason: 'tool_calls', createdAt },
      { id: 'msg_result', role: 'toolResult', content: 'Trace', toolName: 'inspect', toolCallId: 'tc_inspect',
        isError: false, durationMs: 4, artifactId: 'art_demo', summary, createdAt },
      { id: 'msg_answer', role: 'assistant', content: 'Answer', toolCalls: [], stopReason: 'stop', createdAt },
    ];
    const original = structuredClone(messages);
    expect(projectToLLMMessages('System', messages)).toEqual([
      { role: 'system', content: 'System' }, { role: 'user', content: 'Question' },
      { role: 'assistant', content: '', toolCalls: [call('inspect')] },
      { role: 'tool', content: 'Trace', toolCallId: 'tc_inspect', name: 'inspect' }, { role: 'assistant', content: 'Answer' },
    ]);
    expect(projectToLLMMessages('', [])).toEqual([]);
    expect(messages).toEqual(original);
  });

  it('completes a text turn and awaits the event observer in causal order', async () => {
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({ turns: [{ text: '查🙂', chunkSize: 1 }] });
    let delivering = false;
    const state = await runAgentLoop(options(provider, events, {
      async onEvent(event) {
        expect(delivering).toBe(false);
        delivering = true;
        await Promise.resolve();
        events.push(event);
        delivering = false;
      },
    }));
    expect(events.map(({ type }) => type)).toEqual([
      'agent_start', 'turn_start', 'message_start', 'message_update', 'message_update', 'message_end', 'turn_end', 'agent_end',
    ]);
    expect(events.at(-1)).toMatchObject({ status: 'completed', stopReason: 'completed', finalAnswer: '查🙂' });
    expect(state).toMatchObject({ status: 'completed', step: 1, maxSteps: null, error: null, pendingToolCalls: [] });
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: '查🙂', stopReason: 'stop' });
    expect(AgentStateSchema.parse(state)).toEqual(state);
    assertBalanced(events);
  });

  it('continues past twelve steps by default and can still be stopped', async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const provider = createMockLLMProvider({ turns: () => ({ toolCalls: [call('inspect')] }) });
    const state = await runAgentLoop(options(provider, events, {
      signal: controller.signal, tools: [tool('inspect', async () => ({ content: 'OK', isError: false }))],
      onEvent(event) {
        events.push(event);
        if (event.type === 'turn_end' && event.step === 13) controller.abort();
      },
    }));
    expect(state).toMatchObject({ maxSteps: null, step: 13, status: 'stopped', stopReason: 'user_abort' });
    expect(provider.recordedRequests).toHaveLength(13);
    assertBalanced(events);
  });

  it('runs tools serially, forwards progress and artifacts, and lets the model recover from tool errors', async () => {
    const events: AgentEvent[] = [];
    const order: string[] = [];
    const signal = new AbortController().signal;
    const provider = createMockLLMProvider({ turns: [
      { chunks: [
        { type: 'toolcall_delta', toolCallId: 'tc_inspect', toolName: 'inspect', argumentsDelta: '{"input":' },
        ...[call('inspect'), call('missing'), call('bad'), call('followup')].map((toolCall) => ({
          type: 'toolcall_complete' as const, toolCall,
        })),
        { type: 'done', stopReason: 'tool_calls' },
      ] },
      { text: 'Recovered correctly.' },
    ] });
    const tools = [
      tool('inspect', async (args, ctx) => {
        expect(args).toEqual({ input: 'inspect' });
        expect(ctx).toMatchObject({ runId: 'run_demo', sessionId: 'ses_demo', toolCallId: 'tc_inspect', targetPath: '/fixtures' });
        expect(ctx.signal).toBe(signal);
        expect(ctx.artifactStore).toBe(artifactStore);
        order.push('inspect:start');
        ctx.onProgress?.({ elapsedMs: 1, progressMessage: 'first' });
        ctx.onProgress?.({ elapsedMs: 2, progressMessage: 'second' });
        await Promise.resolve();
        order.push('inspect:end');
        return { content: 'artifact pointer', isError: false, artifactId: 'art_demo', summary, preview: 'x'.repeat(239) + '🙂a' };
      }),
      tool('bad', async () => {
        order.push('bad');
        throw new Error('tool internal detail');
      }),
      tool('followup', async () => {
        order.push('followup');
        return { content: 'followed up', isError: false };
      }),
    ];
    let delivering = false;
    const state = await runAgentLoop(options(provider, events, { tools, signal, async onEvent(event) {
      expect(delivering).toBe(false);
      delivering = true;
      await Promise.resolve();
      events.push(event);
      delivering = false;
    } }));
    expect(order).toEqual(['inspect:start', 'inspect:end', 'bad', 'followup']);
    expect(new Set(events.map(({ type }) => type)).size).toBe(10);
    expect(events.find((event) => event.type === 'message_update')).toMatchObject({
      deltaType: 'toolcall_delta', delta: '{"input":', toolCallId: 'tc_inspect',
    });
    const inspectEvents = events.filter((event) => 'toolCallId' in event && event.toolCallId === 'tc_inspect').slice(1);
    expect(inspectEvents.map(({ type }) => type)).toEqual([
      'tool_execution_start', 'tool_execution_update', 'tool_execution_update', 'tool_execution_end',
    ]);
    expect(inspectEvents.at(-1)).toMatchObject({ artifactId: 'art_demo', preview: 'x'.repeat(239), summary, isError: false });
    expect(state).toMatchObject({ status: 'completed', step: 2, pendingToolCalls: [] });
    const received = provider.recordedRequests[1]?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(received.map(({ toolCallId }) => toolCallId)).toEqual(['tc_inspect', 'tc_missing', 'tc_bad', 'tc_followup']);
    expect(JSON.parse(received[1]?.content ?? '')).toMatchObject({ error: { code: 'UNKNOWN_TOOL' } });
    expect(JSON.parse(received[2]?.content ?? '')).toMatchObject({ error: { code: 'TOOL_EXECUTION_ERROR' } });
    expect(received[2]?.content).not.toContain('tool internal detail');
    expect(state.messages.filter((message) => message.role === 'toolResult').map(({ isError }) => isError))
      .toEqual([false, true, true, false]);
    assertBalanced(events);
  });

  it('passes a shallow context array copy while preserving earlier and current messages in state', async () => {
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({ turns: [{ text: 'response' }] });
    const initial: AgentMessage[] = [{ id: 'msg_previous', role: 'user', content: 'Previous', createdAt }];
    const transformContext = vi.fn(async (messages: readonly AgentMessage[]) => {
      const copy = messages as AgentMessage[];
      expect(copy.map(({ content }) => content)).toEqual(['Previous', 'Inspect this run.']);
      copy.shift();
      return copy.map((message) => ({ ...message, content: 'Projected request' }));
    });
    const state = await runAgentLoop(options(provider, events, { initialMessages: initial, transformContext }));
    expect(provider.recordedRequests[0]?.messages).toEqual([
      { role: 'system', content: 'Use trace evidence.' }, { role: 'user', content: 'Projected request' },
    ]);
    expect(state.messages.map(({ content }) => content)).toEqual(['Previous', 'Inspect this run.', 'response']);
    expect(initial).toHaveLength(1);
    expect(transformContext).toHaveBeenCalledOnce();
  });

  it('stops after the exact tool-turn budget and drops stale progress even when a later turn reuses the ID', async () => {
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({
      turns: (_request, index) => ({ text: 'turn ' + index, toolCalls: [call('inspect')] }),
    });
    let late: (() => void) | undefined;
    const execute = vi.fn<AgentTool['execute']>(async (_args, ctx) => {
      late?.();
      late = () => ctx.onProgress?.({ elapsedMs: 100, progressMessage: 'stale' });
      ctx.onProgress?.({ elapsedMs: 1, progressMessage: 'live' });
      return { content: 'step result', isError: false };
    });
    const state = await runAgentLoop(options(provider, events, { maxSteps: 2, tools: [tool('inspect', execute)] }));
    expect(provider.recordedRequests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ status: 'stopped', stopReason: 'max_steps', step: 2, pendingToolCalls: [] });
    expect(events.at(-1)).toMatchObject({ stopReason: 'max_steps', finalAnswer: 'turn 1' });
    late?.();
    await Promise.resolve();
    expect(events.filter((event) => event.type === 'tool_execution_update').map(({ progressMessage }) => progressMessage))
      .toEqual(['live', 'live']);
    assertBalanced(events);
  });

  it('gives an answer priority when a text-only turn completes at the step limit', async () => {
    const provider = createMockLLMProvider({ turns: [{ text: 'answer' }] });
    const state = await runAgentLoop(options(provider, [], { maxSteps: 1 }));
    expect(state).toMatchObject({ status: 'completed', stopReason: 'completed', step: 1 });
  });

  it.each([
    [new LLMProviderError('LLM_AUTH_ERROR', 'Denied. Authorization: Bearer private-fixture'), 'LLM_AUTH_ERROR'],
    [undefined, 'LLM_PROTOCOL_ERROR'],
  ] as const)('closes a partial assistant and reports model failure as %s', async (error, code) => {
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({ turns: [{ chunks: [{ type: 'text_delta', delta: 'partial' }], error }] });
    const state = await runAgentLoop(options(provider, events));
    expect(state).toMatchObject({ status: 'failed', stopReason: 'error', error: { code }, pendingToolCalls: [] });
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'partial', stopReason: 'error' });
    expect(JSON.stringify(events)).not.toContain('private-fixture');
    assertBalanced(events);
  });

  it('validates IDs, prompt and the step budget before starting a run', async () => {
    const provider = createMockLLMProvider({ turns: [{ text: 'unused' }] });
    for (const input of [{ runId: 'bad' }, { sessionId: 'bad' }, { prompt: '   ' }, { maxSteps: 0 }, { maxSteps: 1.5 }]) {
      const events: AgentEvent[] = [];
      await expect(runAgentLoop(options(provider, events, input))).rejects.toThrow();
      expect(events).toEqual([]);
    }
    expect(provider.recordedRequests).toEqual([]);
  });
});

describe('[F06_RUN_STOP_AND_INVARIANTS] cancellation and agent termination', () => {
  it('stops before model or context calls when already aborted', async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const provider = createMockLLMProvider({ turns: [{ text: 'unused' }] });
    const transformContext = vi.fn();
    const state = await runAgentLoop(options(provider, events, { signal: controller.signal, transformContext }));
    expect(state).toMatchObject({ status: 'stopped', stopReason: 'user_abort', step: 0, pendingToolCalls: [] });
    expect(events.map(({ type }) => type)).toEqual(['agent_start', 'agent_end']);
    expect(provider.recordedRequests).toEqual([]);
    expect(transformContext).not.toHaveBeenCalled();
  });

  it('stops while a context transform is pending and never starts an assistant message', async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const provider = createMockLLMProvider({ turns: [{ text: 'unused' }] });
    const state = await runAgentLoop(options(provider, events, {
      signal: controller.signal,
      transformContext: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      },
    }));
    expect(state).toMatchObject({ status: 'stopped', stopReason: 'user_abort', step: 1, pendingToolCalls: [] });
    expect(events.map(({ type }) => type)).toEqual(['agent_start', 'turn_start', 'agent_end']);
    expect(provider.recordedRequests).toEqual([]);
  });

  it('preserves streamed text and closes the iterator even if its pending read ignores cancellation', async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const read = vi.fn<() => Promise<IteratorResult<LLMStreamChunk>>>()
      .mockResolvedValueOnce({ done: false, value: { type: 'text_delta', delta: 'partial text' } })
      .mockImplementation(() => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      });
    const provider: LLMProvider = {
      name: 'slow',
      stream: ({ signal }) => {
        expect(signal).toBe(controller.signal);
        return { [Symbol.asyncIterator]: () => ({ next: read, return: close }) };
      },
    };
    const state = await runAgentLoop(options(provider, events, { signal: controller.signal }));
    expect(close).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ status: 'stopped', stopReason: 'user_abort', pendingToolCalls: [] });
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'aborted', content: 'partial text' });
    expect(events.at(-2)).toMatchObject({ type: 'message_end', message: { stopReason: 'aborted' } });
    assertBalanced(events);
  });

  it('emits an error end for an aborted slow tool and discards its delayed callback and result', async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const release = deferred<void>();
    const finishedTool = deferred<void>();
    const provider = createMockLLMProvider({ turns: [{ toolCalls: [call('slow'), call('never')] }] });
    const next = vi.fn<AgentTool['execute']>();
    const tools = [
      tool('slow', async (_args, ctx) => {
        ctx.onProgress?.({ elapsedMs: 1, progressMessage: 'started' });
        await release.promise;
        await delay(5);
        ctx.onProgress?.({ elapsedMs: 10, progressMessage: 'after termination' });
        finishedTool.resolve();
        return { content: 'late result', isError: false };
      }),
      tool('never', next),
    ];
    const state = await runAgentLoop(options(provider, events, { signal: controller.signal, tools, onEvent(event) {
      events.push(event);
      if (event.type === 'tool_execution_update') controller.abort();
    } }));
    expect(state).toMatchObject({ status: 'stopped', stopReason: 'user_abort', pendingToolCalls: [] });
    expect(events.at(-2)).toMatchObject({ type: 'tool_execution_end', toolCallId: 'tc_slow', isError: true });
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', status: 'stopped', stopReason: 'user_abort' });
    expect(state.messages.at(-1)).toMatchObject({ role: 'toolResult', isError: true, toolCallId: 'tc_slow' });
    expect(JSON.parse(state.messages.at(-1)?.content ?? '')).toMatchObject({ error: { code: 'TOOL_ABORTED' } });
    expect(next).not.toHaveBeenCalled();
    const snapshot = structuredClone({ state, events });
    release.resolve();
    await finishedTool.promise;
    expect({ state, events }).toEqual(snapshot);
    assertBalanced(events);
  });

  it('preserves terminal state if delivery of agent_end fails', async () => {
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({ turns: [{ text: 'answer' }] });
    const state = await runAgentLoop(options(provider, events, { onEvent(event) {
      events.push(event);
      if (event.type === 'agent_end') throw new Error('Observer closed.');
    } }));
    expect(state).toMatchObject({ status: 'completed', stopReason: 'completed' });
    assertBalanced(events);
  });

  it('balances and terminates 100 seeded combinations of budget, tools, aborts and model errors', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 6, maxLength: 6 }),
      fc.constantFrom('none', 'abort_message', 'abort_tool', 'model_error'), fc.integer({ min: 1, max: 6 }),
      async (maxSteps, counts, injection, injectAt) => {
        const controller = new AbortController();
        const events: AgentEvent[] = [];
        const late: Array<() => void> = [];
        const provider = createMockLLMProvider({ turns: (_request, index) => ({
          text: 'trace',
          toolCalls: Array.from({ length: counts[index] ?? 0 }, (_, sequence) => call('inspect', 'call_' + sequence)),
          ...(injection === 'model_error' && index + 1 === injectAt
            ? { error: new LLMProviderError('LLM_RATE_LIMITED', 'Rate limited.') } : {}),
        }) });
        const inspect = tool('inspect', async (_args, ctx) => {
          late.push(() => ctx.onProgress?.({ elapsedMs: 5 }));
          return { content: 'ok', isError: false };
        });
        let step = 0;
        const state = await runAgentLoop(options(provider, events, { signal: controller.signal, maxSteps, tools: [inspect],
          onEvent(event) {
            events.push(event);
            if (event.type === 'turn_start') step = event.step;
            if (step === injectAt && ((injection === 'abort_message' && event.type === 'message_update')
              || (injection === 'abort_tool' && event.type === 'tool_execution_start'))) controller.abort();
          },
        }));
        const count = events.length;
        for (const callback of late) callback();
        await Promise.resolve();
        expect(events).toHaveLength(count);
        expect(state.pendingToolCalls).toEqual([]);
        expect(state.step).toBeLessThanOrEqual(maxSteps);
        expect(AgentStateSchema.safeParse(state).success).toBe(true);
        expect(events.at(-1)).toMatchObject({ status: state.status, stopReason: state.stopReason });
        assertBalanced(events);
      },
    ), { seed: 20601, numRuns: 100 });
  });
});
