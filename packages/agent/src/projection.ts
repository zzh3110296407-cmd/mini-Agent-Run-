import type { LLMMessage } from '@mini-agent-run/ai';
import type { AgentMessage } from '@mini-agent-run/shared';

export function projectToLLMMessages(systemPrompt: string, messages: readonly AgentMessage[]): LLMMessage[] {
  const projected: LLMMessage[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  for (const message of messages) {
    const { content } = message;
    switch (message.role) {
      case 'user':
        projected.push({ role: 'user', content });
        break;
      case 'assistant':
        projected.push({
          role: 'assistant', content,
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
