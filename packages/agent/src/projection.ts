import type { LLMMessage } from '@mini-agent-run/ai';
import type { AgentMessage } from '@mini-agent-run/shared';

export function projectToLLMMessages(systemPrompt: string, messages: readonly AgentMessage[]): LLMMessage[] {
  const projected: LLMMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  let lastUserIndex = messages.length - 1;
  while (lastUserIndex >= 0 && messages[lastUserIndex]?.role !== 'user') lastUserIndex--;
  for (const [index, message] of messages.entries()) {
    const { content } = message;
    switch (message.role) {
      case 'user':
        projected.push({ role: 'user', content });
        break;
      case 'assistant':
        projected.push({
          role: 'assistant', content,
          ...(index > lastUserIndex && message.reasoningContent !== undefined
            ? { reasoningContent: message.reasoningContent } : {}),
          ...(message.toolCalls.length ? { toolCalls: [...message.toolCalls] } : {}),
        });
        break;
      case 'toolResult':
        projected.push({ role: 'tool', toolCallId: message.toolCallId, name: message.toolName, content });
        break;
    }
  }
  return projected;
}
