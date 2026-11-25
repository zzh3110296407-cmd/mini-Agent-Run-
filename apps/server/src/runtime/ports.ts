import type { ArtifactStorePort, TraceWorkspacePort } from '@mini-agent-run/agent';
import type { LLMProvider } from '@mini-agent-run/ai';
import type { PriorSessionRun } from '@mini-agent-run/debug-agent';
import type { AgentEvent, InvestigationRun, RunEventEnvelope, Session, ToolMode } from '@mini-agent-run/shared';
import type { RunRedactor } from './run-redaction.js';

export type AgentEndEvent = Extract<AgentEvent, { type: 'agent_end' }>;

export interface RunStorePort {
  getSession(sessionId: string): Session | null;
  createRun(input: Pick<InvestigationRun, 'sessionId' | 'prompt' | 'maxSteps' | 'modelId' | 'modelProvider' | 'toolMode'>
    & { retryOfRunId?: string }): InvestigationRun;
  markRunning(runId: string, startedAt: string): boolean;
  appendEvents(runId: string, events: readonly Exclude<AgentEvent, AgentEndEvent>[]): RunEventEnvelope[];
  finishRun(runId: string, endedAt: string, agentEnd: AgentEndEvent):
    | { updated: false }
    | { updated: true; run: InvestigationRun; envelope: RunEventEnvelope };
  getRun(runId: string): InvestigationRun | null;
  listRunEvents(runId: string, afterSeq?: number): RunEventEnvelope[];
  listPriorSessionRuns(sessionId: string): PriorSessionRun[];
}

export type RunWorkspaceFactory = (session: Session) => TraceWorkspacePort;

export interface ResolvedLlmProvider {
  provider: LLMProvider;
  modelId: string;
  providerName: string;
  redactor?: RunRedactor;
}

export type RunProviderResolver = (apiKeyOverride?: string) => ResolvedLlmProvider;

export interface RunCoordinatorOptions {
  store: RunStorePort;
  artifactStore: ArtifactStorePort;
  createWorkspace: RunWorkspaceFactory;
  resolveProvider: RunProviderResolver;
  resolveAllowedRoots: () => string[];
  toolMode: ToolMode;
  coalesceWindowMs?: number;
  coalesceMaxChars?: number;
  diagnosticsDefaultDelayMs?: number;
  diagnosticsProgressIntervalMs?: number;
  contextWindowTokens?: number;
}

const errors = {
  SESSION_NOT_FOUND: [404, 'Session not found.'],
  RUN_NOT_FOUND: [404, 'Run not found.'],
  SESSION_HAS_ACTIVE_RUN: [409, 'The session already has an active run.'],
  RUN_STILL_ACTIVE: [409, 'The run is still active.'],
  RUN_NOT_RETRYABLE: [409, 'Only stopped or failed runs may be retried.'],
  RETRY_LIMIT_EXCEEDED: [409, 'The retry limit for this run has been reached.'],
  LLM_NOT_CONFIGURED: [503, 'The language model is not configured.'],
} as const;

export class RunCoordinatorError extends Error {
  readonly statusCode: 404 | 409 | 503;

  constructor(readonly code: keyof typeof errors) {
    const [status, message] = errors[code];
    super(message);
    this.statusCode = status;
  }
}

export function isActiveRun(status: InvestigationRun['status']): status is 'pending' | 'running' {
  return status === 'pending' || status === 'running';
}
