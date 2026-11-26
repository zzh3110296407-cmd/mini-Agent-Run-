import { LLMProviderError, redactSecret, type LLMMessage, type LLMProvider } from '@mini-agent-run/ai';
import {
  AgentEventSchema, AgentMessageSchema, AgentStateSchema, DEFAULT_MAX_STEPS, NonBlankStringSchema, ToolCallRequestSchema,
  type AgentEvent, type AgentMessage, type AgentState, type RunStepLimit, type ToolCallRequest, type ToolMode,
} from '@mini-agent-run/shared';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import type { AgentTool, ArtifactStorePort, ContextTransform, ToolExecutionResult, ToolProgressEvent } from './index.js';
import { projectToLLMMessages } from './projection.js';

export interface RunAgentLoopOptions {
  runId: string;
  sessionId: string;
  prompt: string;
  systemPrompt: string;
  model: { provider: string; modelId: string };
  provider: LLMProvider;
  tools: readonly AgentTool[];
  targetPath: string;
  allowedRoots: readonly string[];
  toolMode: ToolMode;
  artifactStore: ArtifactStorePort;
  signal: AbortSignal;
  maxSteps?: RunStepLimit;
  initialMessages?: readonly AgentMessage[];
  transformContext?: ContextTransform;
  onEvent?: (event: AgentEvent) => Promise<void> | void;
}

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;
type AgentEnd = Omit<Extract<AgentEvent, { type: 'agent_end' }>, 'type' | 'durationMs' | 'conclusion'>;

const messageId = () => 'msg_' + randomUUID();
const timestamp = () => new Date().toISOString();
const elapsed = (start: number) => Math.max(0, Math.round(performance.now() - start));

function waitForActive<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let listener: ReturnType<typeof addAbortListener> | undefined;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('The agent run was aborted.'));
    work.then(resolve, reject);
    if (signal.aborted) abort();
    else listener = addAbortListener(signal, abort);
  }).finally(() => listener?.[Symbol.dispose]());
}

function previewOf(text: string): string {
  let preview = '';
  for (const point of text) {
    if (preview.length + point.length > 240) break;
    preview += /[\uD800-\uDFFF]/u.test(point) ? '\uFFFD' : point;
  }
  return preview;
}

function toolError(code: 'UNKNOWN_TOOL' | 'TOOL_EXECUTION_ERROR' | 'TOOL_ABORTED'): ToolExecutionResult {
  const messages = {
    UNKNOWN_TOOL: 'The requested tool is not registered.',
    TOOL_EXECUTION_ERROR: 'The tool could not complete its operation.',
    TOOL_ABORTED: 'The tool was stopped.',
  };
  return { isError: true, content: JSON.stringify({ error: { code, message: messages[code] } }) };
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentState> {
  const { signal, provider, tools, targetPath, allowedRoots, toolMode, artifactStore } = options;
  const prompt = NonBlankStringSchema.parse(options.prompt);
  const state = AgentStateSchema.parse({
    runId: options.runId, sessionId: options.sessionId, model: options.model, systemPrompt: options.systemPrompt,
    status: 'running', stopReason: null, error: null, step: 0, maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    messages: [...options.initialMessages ?? [], { id: messageId(), role: 'user', content: prompt, createdAt: timestamp() }],
    pendingToolCalls: [],
  });
  const toolDefinitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const startedAt = performance.now();
  let terminated = false;

  async function emit(event: AgentEvent) {
    if (terminated) return;
    const parsed = AgentEventSchema.parse(event);
    if (parsed.type === 'agent_end') terminated = true;
    await options.onEvent?.(parsed);
  }

  async function finish(terminal: AgentEnd) {
    state.pendingToolCalls = [];
    state.status = terminal.status;
    state.stopReason = terminal.stopReason;
    state.error = terminal.error ?? null;
    const snapshot = AgentStateSchema.parse(state);
    try {
      await emit({ type: 'agent_end', ...terminal, durationMs: elapsed(startedAt) });
    } catch (error) {
      // A terminal observer cannot change an already delivered state.
      if (!terminated) throw error;
    }
    return snapshot;
  }

  async function consumeModel(messages: LLMMessage[], assistant: AssistantMessage) {
    signal.throwIfAborted();
    const iterator = provider.stream({ model: state.model.modelId, messages, tools: toolDefinitions, signal })[Symbol.asyncIterator]();
    const callIds = new Set<string>();
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await waitForActive(iterator.next(), signal);
        signal.throwIfAborted();
        if (next.done) throw new LLMProviderError('LLM_PROTOCOL_ERROR', 'The model stream ended without completion.');
        const chunk = next.value;
        switch (chunk.type) {
          case 'done':
            return;
          case 'text_delta':
            assistant.content += chunk.delta;
            await emit({ type: 'message_update', messageId: assistant.id, deltaType: chunk.type, delta: chunk.delta });
            break;
          case 'toolcall_delta':
            await emit({
              type: 'message_update', messageId: assistant.id, deltaType: chunk.type, delta: chunk.argumentsDelta,
              toolCallId: chunk.toolCallId, ...(chunk.toolName === undefined ? {} : { toolName: chunk.toolName }),
            });
            break;
          case 'toolcall_complete': {
            const call = ToolCallRequestSchema.safeParse(chunk.toolCall);
            if (!call.success || callIds.has(call.data.id)) {
              throw new LLMProviderError('LLM_PROTOCOL_ERROR', 'The model stream supplied an invalid or repeated tool call.');
            }
            callIds.add(call.data.id);
            assistant.toolCalls.push(call.data);
            break;
          }
        }
      }
    } finally {
      const close = Promise.resolve().then(() => iterator.return?.()).catch(() => {});
      if (!signal.aborted) await waitForActive(close, signal).catch(() => {});
    }
  }

  async function readAssistant() {
    const context = options.transformContext
      ? await waitForActive(Promise.resolve(options.transformContext([...state.messages])), signal)
      : state.messages;
    signal.throwIfAborted();
    const messages = projectToLLMMessages(state.systemPrompt, context);
    const assistant: AssistantMessage = { id: messageId(), role: 'assistant', content: '', toolCalls: [], createdAt: timestamp() };
    try {
      await emit({ type: 'message_start', messageId: assistant.id, role: 'assistant' });
      await consumeModel(messages, assistant);
      signal.throwIfAborted();
      assistant.stopReason = assistant.toolCalls.length ? 'tool_calls' : 'stop';
    } catch (error) {
      assistant.stopReason = signal.aborted ? 'aborted' : 'error';
      throw error;
    } finally {
      state.messages.push(assistant);
      await emit({ type: 'message_end', message: assistant });
    }
    return assistant;
  }

  async function runTool(call: ToolCallRequest) {
    const identity = { toolCallId: call.id, toolName: call.name };
    const step = state.step;
    const start = performance.now();
    state.pendingToolCalls = [{ ...identity, startedAt: timestamp() }];
    let acceptsProgress = true;
    let progress = Promise.resolve();
    let observerFailure: { error: unknown } | undefined;
    const onProgress = ({ elapsedMs, progressMessage }: ToolProgressEvent) => {
      if (terminated || signal.aborted || !acceptsProgress) return;
      progress = progress.then(async () => {
        if (terminated || signal.aborted || observerFailure) return;
        await emit({
          type: 'tool_execution_update', ...identity, elapsedMs,
          ...(progressMessage === undefined ? {} : { progressMessage }),
        });
      }).catch((error: unknown) => { observerFailure ??= { error }; });
    };
    let result: ToolExecutionResult;
    try {
      await emit({ type: 'tool_execution_start', ...identity, step, arguments: call.arguments });
      signal.throwIfAborted();
      const tool = tools.find(({ name }) => name === call.name);
      if (tool) {
        try {
          result = await waitForActive(tool.execute(call.arguments, {
            runId: state.runId, sessionId: state.sessionId, toolCallId: call.id,
            targetPath, allowedRoots, toolMode, artifactStore, signal, onProgress,
          }), signal);
          if (typeof result.content !== 'string' || typeof result.isError !== 'boolean') result = toolError('TOOL_EXECUTION_ERROR');
        } catch {
          result = toolError('TOOL_EXECUTION_ERROR');
        }
      } else {
        result = toolError('UNKNOWN_TOOL');
      }
    } catch (error) {
      observerFailure = { error };
      result = toolError('TOOL_EXECUTION_ERROR');
    } finally {
      acceptsProgress = false;
      await progress;
    }

    if (signal.aborted) result = toolError('TOOL_ABORTED');
    const durationMs = elapsed(start);
    const base = { ...identity, id: messageId(), role: 'toolResult' as const, durationMs, createdAt: timestamp() };
    let message: ToolResultMessage = {
      ...base, content: result.content, isError: result.isError,
      ...(result.artifactId === undefined ? {} : { artifactId: result.artifactId }),
      ...(result.summary === undefined ? {} : { summary: result.summary }),
    };
    if (!AgentMessageSchema.safeParse(message).success) {
      result = toolError('TOOL_EXECUTION_ERROR');
      message = { ...base, content: result.content, isError: true };
    }
    state.pendingToolCalls = [];
    await emit({
      type: 'tool_execution_end', ...identity, step, durationMs, isError: message.isError,
      preview: previewOf(typeof result.preview === 'string' ? result.preview : message.content),
      ...(message.artifactId === undefined ? {} : { artifactId: message.artifactId }),
      ...(message.summary === undefined ? {} : { summary: message.summary }),
    });
    state.messages.push(message);
    if (observerFailure) throw observerFailure.error;
    signal.throwIfAborted();
  }

  try {
    await emit({ type: 'agent_start', sessionId: state.sessionId, prompt, modelId: state.model.modelId, maxSteps: state.maxSteps });
    for (let step = 1; ; step++) {
      signal.throwIfAborted();
      state.step = step;
      await emit({ type: 'turn_start', step });
      signal.throwIfAborted();
      const assistant = await readAssistant();
      signal.throwIfAborted();
      for (const call of assistant.toolCalls) {
        signal.throwIfAborted();
        await runTool(call);
      }
      await emit({ type: 'turn_end', step, toolCallCount: assistant.toolCalls.length });
      signal.throwIfAborted();
      if (assistant.toolCalls.length === 0) {
        return await finish({ status: 'completed', stopReason: 'completed', finalAnswer: assistant.content });
      }
      if (step === state.maxSteps) {
        return await finish({
          status: 'stopped', stopReason: 'max_steps', ...(assistant.content ? { finalAnswer: assistant.content } : {}),
        });
      }
    }
  } catch (error) {
    if (signal.aborted) return finish({ status: 'stopped', stopReason: 'user_abort' });
    const failure = error instanceof LLMProviderError
      ? { code: error.code, message: redactSecret(error.message).trim() || 'The model request failed.' }
      : { code: 'AGENT_EXECUTION_ERROR', message: 'The agent run could not complete.' };
    return finish({ status: 'failed', stopReason: 'error', error: failure });
  }
}
