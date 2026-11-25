import type {
  AgentMessage, ArtifactContentType, ArtifactMeta, LogLevel, PathType, TextSliceResponse, ToolMode, ToolOutputSummary,
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

export interface TraceWorkspaceBinding {
  readonly targetPath: string;
  readonly pathType: PathType;
}

export interface TraceFileEntry {
  relativePath: string;
  kind: 'file';
  byteSize: number;
  modifiedAt: string;
}

export interface TraceFileContent {
  relativePath: string;
  byteSize: number;
  content: string;
}

export interface TraceListResult {
  entries: readonly TraceFileEntry[];
  truncated: boolean;
}

export interface TraceWorkspacePort {
  readonly binding: TraceWorkspaceBinding;
  resolveTarget(allowedRoots: readonly string[]): Promise<{ realPath: string; kind: PathType }>
    | { realPath: string; kind: PathType };
  listFiles(
    allowedRoots: readonly string[], options?: { maxFiles?: number; maxDepth?: number },
  ): Promise<TraceListResult> | TraceListResult;
  readFile(
    requestedFile: string | undefined, allowedRoots: readonly string[], options?: { maxBytes?: number },
  ): Promise<TraceFileContent> | TraceFileContent;
  sliceText(
    content: string, query: { offsetLine: number; limit: number; level?: LogLevel; q?: string },
  ): TextSliceResponse;
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
