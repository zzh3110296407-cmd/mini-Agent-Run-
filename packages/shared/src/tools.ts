import { z } from 'zod';
import { ToolOutputSummarySchema } from './agent.js';
import {
  ArtifactContentTypeSchema, ArtifactIdSchema, IsoDateTimeSchema, LogLevelSchema, NonBlankPathSchema,
  NonBlankStringSchema, PathTypeSchema, RunIdSchema, SessionIdSchema, TaskOutcomeSchema, ToolCallIdSchema,
} from './common.js';

const nonnegative = z.number().int().min(0);
const positive = z.number().int().min(1);

export const TraceFormatSchema = z.enum(['trajerrbench_json', 'generic_json', 'jsonl', 'plain_text']);

export const TraceThreeStateSchema = z.object({
  terminationReason: NonBlankStringSchema.nullable(),
  hasToolError: z.boolean(),
  toolErrorCount: nonnegative,
  taskOutcome: TaskOutcomeSchema,
});

export const TraceAnomaliesSchema = z.object({
  firstError: z.object({
    step: nonnegative.optional(),
    line: positive.optional(),
    snippet: z.string(),
  }).nullable(),
  retryLoops: z.array(z.object({
    toolName: NonBlankStringSchema,
    startStep: nonnegative,
    endStep: nonnegative,
    repeatCount: z.number().int().min(2),
  })),
  slowSpans: z.array(z.object({
    step: nonnegative.optional(),
    toolName: NonBlankStringSchema.optional(),
    durationMs: nonnegative,
  })),
});

export const TraceOverviewSchema = z.object({
  file: NonBlankPathSchema,
  format: TraceFormatSchema,
  byteSize: nonnegative,
  lineCount: nonnegative,
  stepCount: nonnegative.nullable(),
  taskSummary: z.string().nullable(),
  threeState: TraceThreeStateSchema,
  anomalies: TraceAnomaliesSchema,
});

export const ArtifactMetaSchema = z.object({
  id: ArtifactIdSchema,
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  toolCallId: ToolCallIdSchema,
  sourceTool: NonBlankStringSchema,
  title: NonBlankStringSchema,
  contentType: ArtifactContentTypeSchema,
  byteSize: nonnegative,
  lineCount: nonnegative,
  summary: ToolOutputSummarySchema,
  createdAt: IsoDateTimeSchema,
});

export const FsBrowseEntrySchema = z.object({
  name: NonBlankPathSchema,
  path: NonBlankPathSchema,
  kind: PathTypeSchema,
  byteSize: nonnegative.optional(),
  modifiedAt: IsoDateTimeSchema.optional(),
});

export const FsBrowseResponseSchema = z.object({
  currentPath: NonBlankPathSchema,
  parentPath: NonBlankPathSchema.nullable(),
  allowedRoots: z.array(NonBlankPathSchema),
  entries: z.array(FsBrowseEntrySchema),
});

export const LogLineSchema = z.object({
  lineNumber: positive,
  level: LogLevelSchema,
  text: z.string(),
});

export const TextSliceResponseSchema = z.object({
  totalLines: nonnegative,
  matchedLines: nonnegative,
  offsetLine: positive,
  limit: positive,
  hasMore: z.boolean(),
  nextOffsetLine: positive.nullable(),
  lines: z.array(LogLineSchema),
}).refine(
  ({ hasMore, nextOffsetLine, offsetLine }) =>
    hasMore ? nextOffsetLine !== null && nextOffsetLine > offsetLine : nextOffsetLine === null,
  { path: ['nextOffsetLine'], message: 'nextOffsetLine must advance when hasMore is true and be null otherwise.' },
);

export type TraceFormat = z.infer<typeof TraceFormatSchema>;
export type TraceThreeState = z.infer<typeof TraceThreeStateSchema>;
export type TraceAnomalies = z.infer<typeof TraceAnomaliesSchema>;
export type TraceOverview = z.infer<typeof TraceOverviewSchema>;
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;
export type FsBrowseEntry = z.infer<typeof FsBrowseEntrySchema>;
export type FsBrowseResponse = z.infer<typeof FsBrowseResponseSchema>;
export type LogLine = z.infer<typeof LogLineSchema>;
export type TextSliceResponse = z.infer<typeof TextSliceResponseSchema>;
