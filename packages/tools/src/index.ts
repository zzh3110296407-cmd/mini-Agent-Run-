import type {
  AgentTool, ArtifactStorePort, ToolExecutionContext, ToolExecutionResult, TraceWorkspacePort,
} from '@mini-agent-run/agent';
import {
  ArtifactIdSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES, TextSliceResponseSchema, type ToolMode,
} from '@mini-agent-run/shared';
import { boundedLinePage, boundedSteps } from './budget.js';
import { checkAbort, errorCode, ToolError } from './tool-error.js';
import { runtimeDiagnostics } from './tools/runtime-diagnostics.js';
import { searchLogs } from './tools/search-logs.js';
import { analyzeTraceDetails, loadTrace, traceRecords } from './trace-analyzer.js';

export { sanitizeTraceContent } from './sanitize.js';
export {
  analyzeTraceContent, analyzeTraceDetails, classifyTraceLine, createTraceLineClassifier, type TraceAnalysisDetails,
} from './trace-analyzer.js';
export { truncateUtf8Safe, truncateUtf8TailSafe } from './utf8.js';
export {
  summarizeToolOutput, formatOffloadedToolResultContent, offloadOversizedToolOutput, wrapToolsWithArtifactOffload,
} from './artifact-offload.js';

export const TOOLS_PACKAGE_NAME = '@mini-agent-run/tools';

export interface ToolRegistryOptions {
  toolMode: ToolMode;
  artifactStore: ArtifactStorePort;
  workspace: TraceWorkspacePort;
  diagnosticsDefaultDelayMs?: number;
  diagnosticsProgressIntervalMs?: number;
}

interface Field<T> {
  schema: Record<string, unknown>;
  accepts(value: unknown): value is T;
  required?: true;
}

type Args<Fields> = {
  [Key in keyof Fields]: Fields[Key] extends Field<infer Value>
    ? Fields[Key]['required'] extends true ? Value : Value | undefined : never;
};

const required = <T>(field: Field<T>) => ({ ...field, required: true as const });

function string(max = 4096): Field<string> {
  return {
    schema: { type: 'string', minLength: 1, maxLength: max },
    accepts: (value): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max,
  };
}

function integer(min: number, max = Number.MAX_SAFE_INTEGER): Field<number> {
  return {
    schema: { type: 'integer', minimum: min, maximum: max },
    accepts: (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max,
  };
}

const level: Field<(typeof LogLevelSchema.options)[number]> = {
  schema: { type: 'string', enum: LogLevelSchema.options },
  accepts: (value): value is (typeof LogLevelSchema.options)[number] => LogLevelSchema.safeParse(value).success,
};
const scenarios = ['healthy', 'slow', 'error'] as const;
const scenario: Field<(typeof scenarios)[number]> = {
  schema: { type: 'string', enum: scenarios },
  accepts: (value): value is (typeof scenarios)[number] => scenarios.some((item) => value === item),
};
const artifactId: Field<string> = {
  schema: { type: 'string', pattern: '^art_[A-Za-z0-9_-]+$' },
  accepts: (value): value is string => ArtifactIdSchema.safeParse(value).success,
};
const regex: Field<string> = {
  schema: { type: 'string', minLength: 1, maxLength: 200 },
  accepts: (value): value is string => typeof value === 'string',
};

const pathErrors = new Set([
  'INVALID_PATH', 'PATH_NOT_A_DIRECTORY', 'PATH_NOT_A_FILE', 'PATH_OUTSIDE_ALLOWED_ROOTS',
  'PATH_OUTSIDE_SESSION_SCOPE', 'PATH_FORBIDDEN', 'PATH_NOT_FOUND', 'FILE_TOO_LARGE',
  'UNSUPPORTED_TRACE_FILE', 'NO_ACCESSIBLE_ROOTS',
]);

function invalidArguments(): never {
  throw new ToolError('INVALID_TOOL_ARGUMENTS', 'The tool arguments are invalid.');
}

function decodeArgs<Fields extends Record<string, Field<unknown>>>(fields: Fields, args: unknown): Args<Fields> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) invalidArguments();
  if (Object.keys(args).some((key) => !Object.hasOwn(fields, key))) invalidArguments();
  const values = Object.entries(fields).map(([key, field]) => {
    const value = Object.hasOwn(args, key) ? (args as Record<string, unknown>)[key] : undefined;
    if (value === undefined ? field.required : !field.accepts(value)) invalidArguments();
    return [key, value];
  });
  return Object.fromEntries(values) as Args<Fields>;
}

function defineTool<Fields extends Record<string, Field<unknown>>>(
  workspace: TraceWorkspacePort, name: string, description: string, fields: Fields,
  run: (args: Args<Fields>, ctx: ToolExecutionContext) => Promise<unknown>,
): AgentTool {
  const requiredFields = Object.keys(fields).filter((key) => fields[key]?.required);
  const properties = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.schema]));
  return {
    name, description,
    parameters: { type: 'object', properties, required: requiredFields, additionalProperties: false },
    async execute(input, ctx): Promise<ToolExecutionResult> {
      try {
        checkAbort(ctx.signal);
        if (ctx.targetPath !== workspace.binding.targetPath) {
          throw new ToolError('WORKSPACE_BINDING_MISMATCH', 'The tool does not belong to this session workspace.');
        }
        const output = await run(decodeArgs(fields, input), ctx);
        checkAbort(ctx.signal);
        return { isError: false, content: JSON.stringify(output) };
      } catch (error) {
        const detail = errorCode(error);
        const problem = ctx.signal.aborted ? new ToolError('TOOL_ABORTED', 'The tool was stopped.')
          : error instanceof ToolError ? error
            : detail && pathErrors.has(detail) ? new ToolError(detail, 'The session path could not be accessed.')
              : new ToolError('TOOL_FAILED', 'The tool could not complete its operation.');
        return { isError: true, content: JSON.stringify({ error: { code: problem.code, message: problem.message } }) };
      }
    },
  };
}

const file = string();
const startLine = integer(1);
const limit = integer(1, MAX_ARTIFACT_SLICE_LINES);
const q = string(1000);
const lineFields = { file, startLine, limit, level, q };

export function createToolRegistry(options: ToolRegistryOptions): readonly AgentTool[] {
  const { workspace } = options;
  return [
    defineTool(workspace, 'list_files', 'List trace files in the current session.', {
      maxFiles: integer(1, 200), maxDepth: integer(0, 5),
    }, async (args, ctx) => {
      const { entries, truncated } = await workspace.listFiles(ctx.allowedRoots, args);
      const files = entries.map(({ relativePath, byteSize, modifiedAt }) => ({
        path: relativePath, byteSize, modifiedAt, extension: /\.[^./]+$/.exec(relativePath)?.[0].toLowerCase() ?? '',
      }));
      return { files, total: files.length, truncated };
    }),
    defineTool(workspace, 'inspect_trace', 'Inspect a trace and identify errors, retries, and slow operations.', {
      file,
    }, async ({ file }, ctx) => {
      const input = await workspace.readFile(file, ctx.allowedRoots);
      checkAbort(ctx.signal);
      return analyzeTraceDetails(input.relativePath, input.content).overview;
    }),
    defineTool(workspace, 'read_file_slice', 'Read sanitized trace lines or steps with their original positions.', {
      ...lineFields, startStep: integer(0), endStep: integer(0),
    }, async (args, ctx) => {
      if (args.startStep !== undefined && args.endStep !== undefined && args.startStep > args.endStep) invalidArguments();
      const input = await workspace.readFile(args.file, ctx.allowedRoots);
      checkAbort(ctx.signal);
      const trace = loadTrace(input.content, input.relativePath);
      if (args.startStep !== undefined || args.endStep !== undefined) {
        const records = traceRecords(trace)
          .filter(({ step }) => step >= (args.startStep ?? 0) && step <= (args.endStep ?? Number.MAX_SAFE_INTEGER))
          .sort((a, b) => a.step - b.step);
        return boundedSteps(input.relativePath, records);
      }
      const offsetLine = args.startLine ?? 1;
      const count = args.limit ?? MAX_ARTIFACT_SLICE_LINES;
      const page = workspace.sliceText(trace.sanitized, { offsetLine, limit: count, level: args.level, q: args.q });
      return boundedLinePage(page, offsetLine, count, { file: input.relativePath });
    }),
    defineTool(workspace, 'search_logs', 'Search sanitized traces by text or a restricted regular expression.', {
      query: q, regex, file, level, contextLines: integer(0, 3), maxMatches: integer(1, 100),
    }, (args, ctx) => searchLogs(workspace, args, ctx)),
    defineTool(workspace, 'read_artifact_slice', 'Read a bounded page of a diagnostic artifact owned by the current session.', {
      artifactId: required(artifactId), startLine, limit, level, query: q,
    }, async (args, ctx) => {
      const offsetLine = args.startLine ?? 1;
      const count = args.limit ?? MAX_ARTIFACT_SLICE_LINES;
      const meta = await ctx.artifactStore.getMeta(args.artifactId);
      checkAbort(ctx.signal);
      if (!meta) throw new ToolError('ARTIFACT_NOT_FOUND', 'The diagnostic artifact was not found.');
      if (meta.sessionId !== ctx.sessionId) throw new ToolError('ARTIFACT_FORBIDDEN', 'The artifact belongs to a different session.');
      const slice = await ctx.artifactStore.readSlice(args.artifactId, { offsetLine, limit: count, level: args.level, query: args.query });
      if (!slice) throw new ToolError('ARTIFACT_NOT_FOUND', 'The diagnostic artifact was not found.');
      return boundedLinePage(TextSliceResponseSchema.parse(slice), offsetLine, count);
    }),
    defineTool(workspace, 'compare_files', 'Compare trace outcomes, anomaly reports, and ordered tool calls.', {
      fileA: required(file), fileB: required(file),
    }, async ({ fileA, fileB }, ctx) => {
      const first = await workspace.readFile(fileA, ctx.allowedRoots);
      checkAbort(ctx.signal);
      const a = analyzeTraceDetails(first.relativePath, first.content);
      const second = await workspace.readFile(fileB, ctx.allowedRoots);
      checkAbort(ctx.signal);
      const b = analyzeTraceDetails(second.relativePath, second.content);
      const different = a.toolCalls.findIndex((call, i) => (
        call.toolName !== b.toolCalls[i]?.toolName || call.isError !== b.toolCalls[i]?.isError
      ));
      const difference = different === -1 ? a.toolCalls.length : different;
      const left = a.toolCalls[difference];
      const right = b.toolCalls[difference];
      const firstDivergenceStep = left && right ? Math.min(left.step, right.step) : left?.step ?? right?.step ?? null;
      const diff = <T>(a: T, b: T) => ({ fileA: a, fileB: b });
      const stateA = a.overview.threeState;
      const stateB = b.overview.threeState;
      return {
        firstDivergenceStep,
        threeStateDiff: {
          terminationReason: diff(stateA.terminationReason, stateB.terminationReason),
          hasToolError: diff(stateA.hasToolError, stateB.hasToolError),
          toolErrorCount: diff(stateA.toolErrorCount, stateB.toolErrorCount),
          taskOutcome: diff(stateA.taskOutcome, stateB.taskOutcome),
        },
        toolSequenceDiff: { firstDivergenceStep, callA: left ?? null, callB: right ?? null,
          lengths: diff(a.toolCalls.length, b.toolCalls.length) },
        anomalyDiff: diff(a.overview.anomalies, b.overview.anomalies),
      };
    }),
    defineTool(workspace, 'check_runtime_diagnostics', 'Check workspace access or run a mock runtime diagnostic.', {
      scenario, delayMs: integer(1, 30_000), progressIntervalMs: integer(1, 30_000),
    }, (args, ctx) => runtimeDiagnostics(workspace, args, ctx, options)),
  ];
}
