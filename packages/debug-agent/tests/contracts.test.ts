import {
  AGENT_PACKAGE_NAME, type AgentTool, type ArtifactStorePort, type ToolExecutionContext, type TraceWorkspacePort,
} from '@mini-agent-run/agent';
import { AI_PACKAGE_NAME, type LLMProvider, type LLMStreamChunk } from '@mini-agent-run/ai';
import { DEBUG_AGENT_PACKAGE_NAME, type DebugAgentConfig } from '@mini-agent-run/debug-agent';
import { ArtifactMetaSchema, type ToolOutputSummary } from '@mini-agent-run/shared';
import { TOOLS_PACKAGE_NAME, createToolRegistry } from '@mini-agent-run/tools';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const summary: ToolOutputSummary = {
  byteSize: 2, lineCount: 1, truncatedForLlm: false,
  levelCounts: { error: 0, warn: 0, info: 0, other: 1 }, firstErrorLine: null, previewHead: '{}',
};

describe('M1.1 downstream DI contracts', () => {
  it('compiles this consumer against the emitted workspace declarations', () => {
    const program = ts.createProgram([resolve('packages/debug-agent/tests/contracts.test.ts')], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['node'],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')))
      .toEqual([]);
    type NarrowToolCanUseUnvalidatedArgs = AgentTool<{ file: string }> extends AgentTool ? true : false;
    const narrowToolCanUseUnvalidatedArgs: NarrowToolCanUseUnvalidatedArgs = false;
    expect(narrowToolCanUseUnvalidatedArgs).toBe(false);
  });

  it('assembles a minimal tool registry and debug agent config with a stub provider and store', async () => {
    const store: ArtifactStorePort = {
      save({ content, ...metadata }) {
        return ArtifactMetaSchema.parse({
          ...metadata, id: 'art_sample', byteSize: Buffer.byteLength(content), lineCount: 1,
          createdAt: '2026-11-24T03:00:00.000Z',
        });
      },
      getMeta: () => null,
      readSlice: async () => null,
    };
    const provider: LLMProvider = {
      name: 'fixture',
      async *stream(request) {
        request.signal?.throwIfAborted();
        yield { type: 'text_delta', delta: request.model };
        yield { type: 'done', stopReason: 'stop' };
      },
    };
    const tool: AgentTool = {
      name: 'fixture', description: 'Consumer fixture', parameters: {},
      async execute(args, context) {
        const saved = await context.artifactStore.save({
          runId: context.runId, sessionId: context.sessionId, toolCallId: 'tc_sample',
          sourceTool: this.name, title: 'Fixture output', contentType: 'text/plain',
          content: JSON.stringify(args), summary,
        });
        context.onProgress?.({ elapsedMs: 0 });
        return { content: saved.summary.previewHead, isError: false, artifactId: saved.id, summary };
      },
    };
    const workspace: TraceWorkspacePort = {
      binding: { targetPath: 'trace.json', pathType: 'file' },
      resolveTarget: () => ({ realPath: 'trace.json', kind: 'file' }),
      listFiles: () => ({ entries: [], truncated: false }),
      readFile: () => ({ relativePath: 'trace.json', byteSize: 2, content: '{}' }),
      sliceText: (_content, { offsetLine, limit }) => ({
        totalLines: 0, matchedLines: 0, offsetLine, limit, hasMore: false, nextOffsetLine: null, lines: [],
      }),
    };
    const registry = createToolRegistry({ toolMode: 'mock', artifactStore: store, workspace });
    expect(registry.map(({ name }) => name)).toEqual([
      'list_files', 'inspect_trace', 'read_file_slice', 'search_logs', 'read_artifact_slice', 'compare_files',
      'check_runtime_diagnostics',
    ]);
    const config: DebugAgentConfig = {
      provider, model: 'fixture-model', tools: [...registry, tool],
      transformContext: (messages) => [...messages],
    };
    const progress: number[] = [];
    const signal = new AbortController().signal;
    const context: ToolExecutionContext = {
      runId: 'run_sample', sessionId: 'ses_sample', targetPath: 'trace.json', allowedRoots: ['.'],
      toolMode: 'mock', artifactStore: store, signal,
      onProgress: (event) => progress.push(event.elapsedMs),
    };
    expect(await tool.execute({}, context)).toMatchObject({ isError: false, artifactId: 'art_sample' });
    expect(progress).toEqual([0]);
    expect(await config.transformContext?.([])).toEqual([]);
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of config.provider.stream({ model: config.model, messages: [], signal })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ type: 'text_delta', delta: config.model }, { type: 'done', stopReason: 'stop' }]);
    expect([AGENT_PACKAGE_NAME, AI_PACKAGE_NAME, DEBUG_AGENT_PACKAGE_NAME, TOOLS_PACKAGE_NAME]).toEqual([
      '@mini-agent-run/agent', '@mini-agent-run/ai', '@mini-agent-run/debug-agent', '@mini-agent-run/tools',
    ]);
  });
});
