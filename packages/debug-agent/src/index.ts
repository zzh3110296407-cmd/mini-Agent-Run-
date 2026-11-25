import type { AgentTool, ContextTransform } from '@mini-agent-run/agent';
import type { LLMProvider } from '@mini-agent-run/ai';

export const DEBUG_AGENT_PACKAGE_NAME = '@mini-agent-run/debug-agent';

export {
  DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPRESSION_TRIGGER_RATIO, DEFAULT_INPUT_HARD_CAP_RATIO,
  estimateTokenCount, estimateMessagesTokens, estimatePromptAndToolsTokens,
  buildSessionHistoryMessages, createDebugContextTransform, type PriorSessionRun, type DebugContextOptions,
} from './context.js';
export { buildDebugSystemPrompt, type DebugSystemPromptOptions } from './prompt.js';
export { extractInvestigationConclusion, type ExtractedInvestigationConclusion } from './conclusion.js';
export {
  createDebugAgent, runDebugInvestigation, type DebugInvestigationInput, type DebugInvestigationOptions,
  type DebugInvestigationResult,
} from './runner.js';

export interface DebugAgentConfig {
  provider: LLMProvider;
  model: string;
  tools: readonly AgentTool[];
  transformContext?: ContextTransform;
  maxSteps?: number;
  providerName?: string;
  systemPrompt?: string;
  maxInlineToolBytes?: number;
  contextWindowTokens?: number;
  compressionTriggerRatio?: number;
  inputHardCapRatio?: number;
}
