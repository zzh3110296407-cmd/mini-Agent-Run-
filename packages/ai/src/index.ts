import type { ToolCallRequest } from '@mini-agent-run/shared';

export const AI_PACKAGE_NAME = '@mini-agent-run/ai';

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LLMMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LLMGenerateRequest {
  model: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  signal?: AbortSignal;
}

export type LLMStreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'toolcall_delta'; toolCallId: string; toolName?: string; argumentsDelta: string }
  | { type: 'toolcall_complete'; toolCall: ToolCallRequest }
  | { type: 'done'; stopReason: 'stop' | 'tool_calls' };

export interface LLMProvider {
  readonly name: string;
  stream(request: LLMGenerateRequest): AsyncIterable<LLMStreamChunk>;
}
