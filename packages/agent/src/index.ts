import type {
  AgentMessage, ArtifactContentType, ArtifactMeta, LogLevel, TextSliceResponse, ToolMode, ToolOutputSummary,
} from '@mini-agent-run/shared';

export const AGENT_PACKAGE_NAME = '@mini-agent-run/agent';

export interface SaveArtifactInput {
  runId: string;
  sessionId: string;
  toolCallId: string;
  sourceTool: string;
  title: string;
  contentType: ArtifactContentType;
  content: string;
  summary: ToolOutputSummary;
}

export interface ArtifactSliceQuery {
  offsetLine: number;
  limit: number;
  level?: LogLevel;
  query?: string;
}

export interface ArtifactStorePort {
  save(input: SaveArtifactInput): Promise<ArtifactMeta> | ArtifactMeta;
  getMeta(artifactId: string): Promise<ArtifactMeta | null> | ArtifactMeta | null;
  readSlice(artifactId: string, query: ArtifactSliceQuery): Promise<TextSliceResponse | null> | TextSliceResponse | null;
}

export interface ToolProgressEvent {
  elapsedMs: number;
  progressMessage?: string;
}

export interface ToolExecutionContext {
  runId: string;
  sessionId: string;
  targetPath: string;
  allowedRoots: readonly string[];
  toolMode: ToolMode;
  artifactStore: ArtifactStorePort;
  signal: AbortSignal;
  onProgress?: (progress: ToolProgressEvent) => void;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  preview?: string;
  artifactId?: string;
  summary?: ToolOutputSummary;
}

export interface AgentTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute: (args: TArgs, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>;
}

export type ContextTransform = (messages: readonly AgentMessage[]) => Promise<AgentMessage[]> | AgentMessage[];
