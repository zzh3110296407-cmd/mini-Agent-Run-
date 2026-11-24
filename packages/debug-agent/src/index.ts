import type { AgentTool, ContextTransform } from '@mini-agent-run/agent';
import type { LLMProvider } from '@mini-agent-run/ai';

export const DEBUG_AGENT_PACKAGE_NAME = '@mini-agent-run/debug-agent';

export interface DebugAgentConfig {
  provider: LLMProvider;
  model: string;
  tools: readonly AgentTool[];
  transformContext?: ContextTransform;
  maxSteps?: number;
}
