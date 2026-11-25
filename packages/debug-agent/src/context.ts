import type { ContextTransform } from '@mini-agent-run/agent';
import type { LLMToolDefinition } from '@mini-agent-run/ai';
import { AgentMessageSchema, type AgentMessage, type InvestigationRun } from '@mini-agent-run/shared';
import { truncateUtf8Safe } from '@mini-agent-run/tools';
import { randomUUID } from 'node:crypto';

export const DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DEFAULT_COMPRESSION_TRIGGER_RATIO = 0.55;
export const DEFAULT_INPUT_HARD_CAP_RATIO = 0.70;

export type PriorSessionRun = Pick<
  InvestigationRun, 'id' | 'status' | 'prompt' | 'finalAnswer' | 'conclusion' | 'createdAt' | 'endedAt'
> & Partial<Pick<InvestigationRun, 'sessionId'>>;

export interface DebugContextOptions {
  contextWindowTokens?: number;
  triggerRatio?: number;
  hardCapRatio?: number;
  keepRecentToolTurns?: number;
  fixedOverheadTokens?: number;
}

type ToolResult = Extract<AgentMessage, { role: 'toolResult' }>;
type ToolTurn = { start: number; end: number; complete: boolean };
const messageOverhead = 4;
const asciiPerToken = 3.5;
const loneSurrogate = /[\uD800-\uDFFF]/u;

export function estimateTokenCount(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const point of text) {
    if (point.charCodeAt(0) <= 127) ascii++;
    else nonAscii++;
  }
  return nonAscii + Math.ceil(ascii / asciiPerToken);
}

function estimateMessageTokens(message: AgentMessage): number {
  const calls = message.role === 'assistant' && message.toolCalls.length
    ? estimateTokenCount(JSON.stringify(message.toolCalls)) : 0;
  return messageOverhead + calls + estimateTokenCount(message.content);
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((tokens, message) => tokens + estimateMessageTokens(message), 0);
}

export function estimatePromptAndToolsTokens(systemPrompt: string, tools: readonly LLMToolDefinition[]): number {
  const prompt = systemPrompt ? messageOverhead + estimateTokenCount(systemPrompt) : 0;
  const definitions = tools.length ? estimateTokenCount(JSON.stringify(tools.map(({ name, description, parameters }) => ({
    type: 'function', function: { name, description, parameters },
  })))) : 0;
  return prompt + definitions;
}

export function buildSessionHistoryMessages(priorRuns: readonly PriorSessionRun[]): AgentMessage[] {
  return priorRuns.filter(({ status }) => status === 'completed')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .flatMap((run) => [
      AgentMessageSchema.parse({ id: 'msg_' + randomUUID(), role: 'user', content: run.prompt, createdAt: run.createdAt }),
      AgentMessageSchema.parse({
        id: 'msg_' + randomUUID(), role: 'assistant', content: run.finalAnswer ?? run.conclusion?.summary ?? '',
        toolCalls: [], stopReason: 'stop', createdAt: run.endedAt ?? run.createdAt,
      }),
    ]);
}

function toolTurns(messages: readonly AgentMessage[]): ToolTurn[] {
  const turns: ToolTurn[] = [];
  for (const [start, assistant] of messages.entries()) {
    if (assistant.role !== 'assistant' || !assistant.toolCalls.length) continue;
    const missing = new Set(assistant.toolCalls.map(({ id }) => id));
    let complete = missing.size === assistant.toolCalls.length;
    let end = start + 1;
    for (let result = messages[end]; result?.role === 'toolResult'; result = messages[++end]) {
      if (!missing.delete(result.toolCallId)) complete = false;
    }
    turns.push({ start, end, complete: complete && missing.size === 0 });
  }
  return turns;
}

function foldedContent(message: ToolResult): string {
  const tool = truncateUtf8Safe(message.toolName, 120).text;
  const status = message.isError ? 'error' : 'ok';
  const pointer = message.artifactId ? `; artifactId=${message.artifactId}; use read_artifact_slice to inspect` : '';
  return `[Folded earlier tool result from ${tool} (${status})${pointer}]`;
}

function truncateToTokens(text: string, limit: number): string {
  let ascii = 0;
  let nonAscii = 0;
  let bytes = 0;
  for (const point of text) {
    if (point.charCodeAt(0) <= 127) ascii++;
    else nonAscii++;
    if (nonAscii + Math.ceil(ascii / asciiPerToken) > limit) break;
    bytes += Buffer.byteLength(point, 'utf8');
  }
  return truncateUtf8Safe(text, bytes).text;
}

function fitText(messages: readonly AgentMessage[], budget: number): AgentMessage[] {
  const output = [...messages];
  let available = budget;
  for (const message of messages) {
    available -= message.role === 'toolResult' ? estimateMessageTokens(message)
      : estimateMessageTokens({ ...message, content: '' });
  }
  if (available < 0) throw new RangeError('The required message structure exceeds the context hard cap.');

  // Keep the current question first, then as much recent assistant text as the budget permits.
  const order = messages.map((_, index) => index).reverse();
  const question = order.find((index) => messages[index]?.role === 'user');
  if (question !== undefined) {
    order.splice(order.indexOf(question), 1);
    order.unshift(question);
  }
  for (const index of order) {
    const message = messages[index];
    if (!message || message.role === 'toolResult') continue;
    const tokens = estimateTokenCount(message.content);
    if (tokens > available) {
      const content = truncateToTokens(message.content, available);
      output[index] = { ...message, content };
      available -= estimateTokenCount(content);
    } else {
      available -= tokens;
    }
  }
  return output;
}

export function createDebugContextTransform({
  contextWindowTokens = DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS,
  triggerRatio = DEFAULT_COMPRESSION_TRIGGER_RATIO,
  hardCapRatio = DEFAULT_INPUT_HARD_CAP_RATIO,
  keepRecentToolTurns = 2,
  fixedOverheadTokens = 0,
}: DebugContextOptions = {}): ContextTransform {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1
      || !Number.isSafeInteger(keepRecentToolTurns) || keepRecentToolTurns < 0
      || !Number.isSafeInteger(fixedOverheadTokens) || fixedOverheadTokens < 0
      || !(0 < triggerRatio && triggerRatio <= hardCapRatio && hardCapRatio < 1)) {
    throw new RangeError('Invalid debug context budget.');
  }
  const trigger = Math.floor(contextWindowTokens * triggerRatio);
  const hardCap = Math.floor(contextWindowTokens * hardCapRatio);
  if (fixedOverheadTokens >= hardCap) throw new RangeError('The fixed prompt and tool overhead reaches the context hard cap.');

  return (messages) => {
    let total = fixedOverheadTokens + estimateMessagesTokens(messages);
    if (total < trigger) return [...messages];

    let currentStart = Math.max(0, messages.length - 1);
    while (currentStart > 0 && messages[currentStart]?.role !== 'user') currentStart--;
    const history = messages.slice(0, currentStart);
    const current = messages.slice(currentStart);
    const turns = toolTurns(current);
    let foldedThrough = 0;
    function foldBefore(end: number) {
      for (; foldedThrough < end; foldedThrough++) {
        const message = current[foldedThrough];
        if (message?.role !== 'toolResult') continue;
        const content = foldedContent(message);
        total += estimateTokenCount(content) - estimateTokenCount(message.content);
        current[foldedThrough] = { ...message, content };
      }
    }

    const firstRecent = keepRecentToolTurns === 0 ? undefined : turns[Math.max(0, turns.length - keepRecentToolTurns)];
    foldBefore(firstRecent?.start ?? current.length);

    let historyStart = 0;
    while (total >= trigger && historyStart < history.length) {
      do {
        const message = history[historyStart++];
        if (message) total -= estimateMessageTokens(message);
      } while (historyStart < history.length && history[historyStart]?.role !== 'user');
    }

    if (total > hardCap) foldBefore(current.length);
    const dropped = new Set<number>();
    if (total > hardCap) {
      for (const turn of turns.slice(0, -1)) {
        if (!turn.complete) continue;
        for (let index = turn.start; index < turn.end; index++) {
          const message = current[index];
          if (message) total -= estimateMessageTokens(message);
          dropped.add(index);
        }
        if (total <= hardCap) break;
      }
    }
    const kept = [...history.slice(historyStart), ...current.filter((_, index) => !dropped.has(index))];
    const fitted = total > hardCap ? fitText(kept, hardCap - fixedOverheadTokens) : kept;
    return fitted.map((message) => loneSurrogate.test(message.content)
      ? { ...message, content: truncateUtf8Safe(message.content, Buffer.byteLength(message.content, 'utf8')).text }
      : message);
  };
}
