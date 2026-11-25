import type { AgentTool, ArtifactStorePort, SaveArtifactInput, ToolExecutionResult } from '@mini-agent-run/agent';
import {
  MAX_INLINE_TOOL_OUTPUT_BYTES, ToolCallIdSchema, ToolOutputSummarySchema,
  type ArtifactContentType, type ArtifactMeta, type ToolOutputSummary,
} from '@mini-agent-run/shared';
import { randomUUID } from 'node:crypto';
import { inlinePrefix } from './budget.js';
import { traceLines } from './sanitize.js';
import { classifyTraceLine } from './trace-analyzer.js';
import { truncateUtf8Safe, truncateUtf8TailSafe } from './utf8.js';

type InlineOptions = { maxInlineBytes?: number };
type SummaryOptions = InlineOptions & { previewHeadBytes?: number; previewTailBytes?: number };
type OffloadMetadata = Omit<SaveArtifactInput, 'content' | 'summary' | 'contentType'> & { contentType?: ArtifactContentType };

function inlineLimit(value = MAX_INLINE_TOOL_OUTPUT_BYTES, minimum = 256) {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_INLINE_TOOL_OUTPUT_BYTES) {
    throw new RangeError(`maxInlineBytes must be an integer from ${minimum} to ${MAX_INLINE_TOOL_OUTPUT_BYTES}.`);
  }
  return value;
}

export function summarizeToolOutput(content: string, options: SummaryOptions = {}): ToolOutputSummary {
  const maxInlineBytes = inlineLimit(options.maxInlineBytes, 1);
  const { previewHeadBytes = 1024, previewTailBytes = 512 } = options;
  const levelCounts = { error: 0, warn: 0, info: 0, other: 0 };
  let lineCount = 0;
  let firstErrorLine: number | null = null;
  for (const { line, text } of traceLines(content)) {
    const level = classifyTraceLine(text);
    levelCounts[level]++;
    lineCount = line;
    if (level === 'error') firstErrorLine ??= line;
  }
  const byteSize = Buffer.byteLength(content);
  const truncatedForLlm = byteSize > maxInlineBytes;
  return ToolOutputSummarySchema.parse({
    byteSize, lineCount, truncatedForLlm, levelCounts, firstErrorLine,
    previewHead: truncateUtf8Safe(content, previewHeadBytes).text,
    ...(truncatedForLlm || byteSize > previewHeadBytes
      ? { previewTail: truncateUtf8TailSafe(content, previewTailBytes).text } : {}),
  });
}

function firstErrorExcerpt(content: string, target: number | null) {
  if (target === null) return undefined;
  for (const { line, text } of traceLines(content)) {
    if (line === target) return truncateUtf8Safe(text, 1024).text;
  }
}

export function formatOffloadedToolResultContent(
  artifact: ArtifactMeta, rawContent: string, options: InlineOptions = {},
): string {
  const maxInlineBytes = inlineLimit(options.maxInlineBytes);
  const { levelCounts, firstErrorLine, previewHead, previewTail } = artifact.summary;
  const required = {
    artifactId: artifact.id, byteSize: artifact.byteSize, lineCount: artifact.lineCount,
    truncatedForLlm: true, levelCounts, firstErrorLine,
  };
  const fits = (body: string) => Buffer.byteLength(body) <= maxInlineBytes;
  if (!fits(JSON.stringify(required))) throw new RangeError('The Artifact metadata exceeds the inline byte budget.');

  const hint = 'read_artifact_slice';
  const details: Partial<Record<
    'sourceTool' | 'title' | 'firstErrorExcerpt' | 'previewHead' | 'previewTail' | 'readHint', string
  >> = {
    sourceTool: truncateUtf8Safe(artifact.sourceTool, 64).text,
    title: truncateUtf8Safe(artifact.title, 128).text,
    firstErrorExcerpt: firstErrorExcerpt(rawContent, firstErrorLine),
    previewHead: truncateUtf8Safe(previewHead, maxInlineBytes).text,
    previewTail: previewTail === undefined ? undefined : truncateUtf8TailSafe(previewTail, maxInlineBytes).text,
    readHint: truncateUtf8Safe(`Use ${hint} with artifactId ${artifact.id}.`, 160).text,
  };
  const serialize = () => JSON.stringify({ ...required, ...details });
  const previews = ['previewTail', 'firstErrorExcerpt', 'previewHead'] as const;
  function shrink(field: keyof typeof details) {
    const original = details[field];
    if (original === undefined) return;
    delete details[field];
    if (!fits(serialize())) return;
    const reverse = (text: string) => Array.from(text).reverse().join('');
    const orient = (text: string) => field === 'previewTail' ? reverse(text) : text;
    const clipped = inlinePrefix(orient(original), (text) => {
      details[field] = orient(text);
      return fits(serialize());
    });
    if (clipped) details[field] = orient(clipped);
    else delete details[field];
  }
  for (const field of previews) {
    if (fits(serialize())) break;
    shrink(field);
  }
  if (!fits(serialize())) details.readHint = hint;
  for (const field of ['title', 'sourceTool', 'readHint'] as const) {
    if (fits(serialize())) break;
    shrink(field);
  }
  return serialize();
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return false;
  }
}

function inferContentType(content: string): ArtifactContentType {
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && isJson(trimmed)) return 'application/json';
  let jsonLines = 0;
  let lines = 0;
  for (const { line, text } of traceLines(content)) {
    lines = line;
    if (!text.trim()) continue;
    if (!isJson(text)) return 'text/plain';
    jsonLines++;
  }
  return lines > 1 && jsonLines > 0 ? 'application/x-ndjson' : 'text/plain';
}

export async function offloadOversizedToolOutput(
  result: ToolExecutionResult, meta: OffloadMetadata, store: ArtifactStorePort, options: InlineOptions = {},
): Promise<ToolExecutionResult> {
  const maxInlineBytes = inlineLimit(options.maxInlineBytes);
  const { content, isError } = result;
  if (Buffer.byteLength(content) <= maxInlineBytes) return result;

  const existing = result.artifactId === undefined ? null : await store.getMeta(result.artifactId);
  const saved = existing?.sessionId === meta.sessionId ? existing : await store.save({
    ...meta, contentType: meta.contentType ?? inferContentType(content), content,
    summary: summarizeToolOutput(content, { maxInlineBytes }),
  });
  const summary = { ...saved.summary, truncatedForLlm: true };
  return {
    content: formatOffloadedToolResultContent(saved, content, { maxInlineBytes }),
    isError, artifactId: saved.id, summary,
    preview: truncateUtf8Safe(summary.previewHead, 240).text,
  };
}

export function wrapToolsWithArtifactOffload(tools: readonly AgentTool[], options: InlineOptions = {}): readonly AgentTool[] {
  const maxInlineBytes = inlineLimit(options.maxInlineBytes);
  return tools.map((tool) => {
    if (tool.name === 'read_artifact_slice') return tool;
    return {
      ...tool,
      async execute(args, ctx) {
        const result = await tool.execute(args, ctx);
        if (Buffer.byteLength(result.content) <= maxInlineBytes) return result;
        const toolCallId = ToolCallIdSchema.safeParse(ctx.toolCallId);
        return offloadOversizedToolOutput(result, {
          runId: ctx.runId, sessionId: ctx.sessionId, toolCallId: toolCallId.success ? toolCallId.data : 'tc_' + randomUUID(),
          sourceTool: tool.name, title: tool.description.trim() || tool.name,
        }, ctx.artifactStore, { maxInlineBytes });
      },
    };
  });
}
