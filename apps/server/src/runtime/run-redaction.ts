import type { ArtifactStorePort } from '@mini-agent-run/agent';
import { AgentEventSchema, type AgentEvent } from '@mini-agent-run/shared';
import { createHash } from 'node:crypto';

export interface RunRedactor {
  text(value: string): string;
  splitDelta(value: string): { safe: string; tail: string };
}

export function createRunRedactor(keys: readonly string[]): RunRedactor {
  const secrets = [...new Set(keys.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length
    ? new RegExp(secrets.map((secret) => secret.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  const text = (value: string) => pattern ? value.replace(pattern, '[REDACTED]') : value;
  return {
    text,
    splitDelta(value) {
      if (pattern === null) return { safe: value, tail: '' };
      // A partial match at a network chunk boundary must stay in memory until resolved.
      let afterMatch = 0;
      for (const match of value.matchAll(pattern)) afterMatch = match.index + match[0].length;
      let hold = 0;
      for (const secret of secrets) {
        const longest = Math.min(secret.length - 1, value.length - afterMatch);
        for (let length = longest; length > hold; length--) {
          if (value.endsWith(secret.slice(0, length))) {
            hold = length;
            break;
          }
        }
      }
      const cut = value.length - hold;
      return { safe: text(value.slice(0, cut)), tail: value.slice(cut) };
    },
  };
}

function scrubJson(input: unknown, redact: RunRedactor): unknown {
  if (typeof input === 'string') return redact.text(input);
  if (Array.isArray(input)) return input.map((value: unknown) => scrubJson(value, redact));
  if (input !== null && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [redact.text(key), scrubJson(value, redact)]));
  }
  return input;
}

function toolId(id: string, redact: RunRedactor) {
  return redact.text(id) === id ? id : 'tc_' + createHash('sha256').update(id).digest('hex').slice(0, 32);
}

export function redactEvent(event: Extract<AgentEvent, { type: 'message_update' }>, redact: RunRedactor):
  Extract<AgentEvent, { type: 'message_update' }>;
export function redactEvent(event: AgentEvent, redact: RunRedactor): AgentEvent;
export function redactEvent(event: AgentEvent, redact: RunRedactor): AgentEvent {
  const identity = 'toolCallId' in event && event.toolCallId !== undefined
    ? { toolCallId: toolId(event.toolCallId, redact) } : {};
  switch (event.type) {
    case 'agent_start':
      return { ...event, prompt: redact.text(event.prompt), modelId: redact.text(event.modelId) };
    case 'message_update':
      return { ...event, ...identity, ...(event.toolName === undefined ? {} : { toolName: redact.text(event.toolName) }) };
    case 'message_end':
      return AgentEventSchema.parse({ ...event, message: {
        ...event.message, content: redact.text(event.message.content),
        toolCalls: event.message.toolCalls.map((call) => ({
          id: toolId(call.id, redact), name: redact.text(call.name), arguments: scrubJson(call.arguments, redact),
        })),
      } });
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return AgentEventSchema.parse({ ...event, ...scrubToolPayload(event, redact), ...identity });
    case 'agent_end':
      return AgentEventSchema.parse({
        ...event,
        ...(event.finalAnswer === undefined ? {} : { finalAnswer: redact.text(event.finalAnswer) }),
        ...(event.error === undefined ? {} : { error: { ...event.error, message: redact.text(event.error.message) } }),
        ...(event.conclusion === undefined ? {} : { conclusion: scrubJson(event.conclusion, redact) }),
      });
    default:
      return event;
  }
}

function scrubToolPayload(event: Extract<AgentEvent, { toolName: string }>, redact: RunRedactor) {
  const toolName = redact.text(event.toolName);
  switch (event.type) {
    case 'tool_execution_start': return { toolName, arguments: scrubJson(event.arguments, redact) };
    case 'tool_execution_update': return {
      toolName, ...(event.progressMessage === undefined ? {} : { progressMessage: redact.text(event.progressMessage) }),
    };
    case 'tool_execution_end': return {
      toolName, preview: redact.text(event.preview),
      ...(event.summary === undefined ? {} : { summary: scrubJson(event.summary, redact) }),
    };
  }
}

export function redactArtifactStore(store: ArtifactStorePort, redact: RunRedactor, signal: AbortSignal): ArtifactStorePort {
  return {
    save(input) {
      signal.throwIfAborted();
      return store.save({
        ...input,
        title: redact.text(input.title),
        sourceTool: redact.text(input.sourceTool),
        toolCallId: toolId(input.toolCallId, redact),
        content: redact.text(input.content),
        summary: {
          ...input.summary, previewHead: redact.text(input.summary.previewHead),
          ...(input.summary.previewTail === undefined ? {} : { previewTail: redact.text(input.summary.previewTail) }),
        },
      });
    },
    getMeta: (id) => store.getMeta(id),
    readSlice: (id, query) => store.readSlice(id, query),
  };
}
