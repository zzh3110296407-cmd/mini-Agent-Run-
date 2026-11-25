import { runAgentLoop, type ContextTransform, type RunAgentLoopOptions } from '@mini-agent-run/agent';
import { AgentEventSchema, type AgentState, type InvestigationConclusion, type PathType } from '@mini-agent-run/shared';
import { wrapToolsWithArtifactOffload } from '@mini-agent-run/tools';
import { extractInvestigationConclusion } from './conclusion.js';
import {
  buildSessionHistoryMessages, createDebugContextTransform, estimatePromptAndToolsTokens, type PriorSessionRun,
} from './context.js';
import type { DebugAgentConfig } from './index.js';
import { buildDebugSystemPrompt } from './prompt.js';

export interface DebugInvestigationOptions extends DebugAgentConfig, Pick<
  RunAgentLoopOptions, 'runId' | 'sessionId' | 'prompt' | 'targetPath' | 'allowedRoots' | 'toolMode' | 'artifactStore' | 'signal' | 'onEvent'
> {
  pathType?: PathType;
  targetLabel?: string;
  priorRuns?: readonly PriorSessionRun[];
}

export type DebugInvestigationInput = Omit<DebugInvestigationOptions, 'provider' | 'model' | 'tools'>;

export interface DebugInvestigationResult {
  state: AgentState;
  finalAnswer: string | null;
  conclusion: InvestigationConclusion | null;
}

export async function runDebugInvestigation(options: DebugInvestigationOptions): Promise<DebugInvestigationResult> {
  const tools = wrapToolsWithArtifactOffload(options.tools, { maxInlineBytes: options.maxInlineToolBytes });
  const systemPrompt = options.systemPrompt ?? buildDebugSystemPrompt({
    pathType: options.pathType, targetLabel: options.targetLabel,
  });
  const priorRuns = options.priorRuns?.filter(({ id, sessionId }) =>
    id !== options.runId && (sessionId === undefined || sessionId === options.sessionId)) ?? [];
  const initialMessages = buildSessionHistoryMessages(priorRuns);
  const debugTransform = createDebugContextTransform({
    contextWindowTokens: options.contextWindowTokens,
    triggerRatio: options.compressionTriggerRatio,
    hardCapRatio: options.inputHardCapRatio,
    fixedOverheadTokens: estimatePromptAndToolsTokens(systemPrompt, tools),
  });
  const customTransform = options.transformContext;
  const transformContext: ContextTransform = customTransform
    ? async (messages) => {
      const transformed = await customTransform(messages);
      options.signal.throwIfAborted();
      return debugTransform(transformed);
    }
    : debugTransform;

  let finalAnswer: string | null = null;
  let conclusion: InvestigationConclusion | null = null;
  const state = await runAgentLoop({
    runId: options.runId, sessionId: options.sessionId, prompt: options.prompt, systemPrompt, provider: options.provider,
    model: { provider: options.providerName ?? options.provider.name, modelId: options.model },
    targetPath: options.targetPath, allowedRoots: options.allowedRoots, toolMode: options.toolMode,
    artifactStore: options.artifactStore, tools, signal: options.signal, maxSteps: options.maxSteps,
    initialMessages, transformContext,
    onEvent(event) {
      if (event.type === 'agent_end') {
        finalAnswer = event.finalAnswer ?? null;
        if (event.status === 'completed' && event.finalAnswer !== undefined) {
          const extracted = extractInvestigationConclusion(event.finalAnswer);
          finalAnswer = extracted.cleanedAnswer;
          conclusion = extracted.conclusion;
          return options.onEvent?.(AgentEventSchema.parse({
            ...event, finalAnswer, ...(conclusion ? { conclusion } : {}),
          }));
        }
      }
      return options.onEvent?.(event);
    },
  });
  return { state, finalAnswer, conclusion };
}

export function createDebugAgent(config: DebugAgentConfig) {
  return {
    config,
    investigate(input: DebugInvestigationInput): Promise<DebugInvestigationResult> {
      return runDebugInvestigation({ ...config, ...input });
    },
  };
}
