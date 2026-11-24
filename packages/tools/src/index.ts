import type { AgentTool, ArtifactStorePort } from '@mini-agent-run/agent';
import type { ToolMode } from '@mini-agent-run/shared';

export const TOOLS_PACKAGE_NAME = '@mini-agent-run/tools';

export interface ToolRegistryOptions {
  toolMode: ToolMode;
  artifactStore: ArtifactStorePort;
}

export function createToolRegistry(options: ToolRegistryOptions): readonly AgentTool[] {
  void options;
  return [];
}
