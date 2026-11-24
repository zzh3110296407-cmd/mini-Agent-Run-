import { z } from 'zod';
import { InvestigationConclusionSchema } from './agent.js';
import {
  IsoDateTimeSchema, NonBlankStringSchema, RunIdSchema, RunStatusSchema, SessionIdSchema, StopReasonSchema,
  ToolModeSchema,
} from './common.js';

const nonnegative = z.number().int().min(0);
const requestedMaxSteps = z.number().int().min(1).max(30).optional();

export const InvestigationRunSchema = z.object({
  id: RunIdSchema,
  sessionId: SessionIdSchema,
  retryOfRunId: RunIdSchema.nullable(),
  prompt: NonBlankStringSchema,
  status: RunStatusSchema,
  stopReason: StopReasonSchema.nullable(),
  errorCode: NonBlankStringSchema.nullable(),
  errorMessage: NonBlankStringSchema.nullable(),
  modelProvider: NonBlankStringSchema,
  modelId: NonBlankStringSchema,
  toolMode: ToolModeSchema,
  stepCount: nonnegative,
  maxSteps: z.number().int().min(1),
  finalAnswer: z.string().nullable(),
  conclusion: InvestigationConclusionSchema.nullable(),
  lastSeq: nonnegative,
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  durationMs: nonnegative.nullable(),
});

export const CreateRunRequestSchema = z.object({
  prompt: NonBlankStringSchema,
  maxSteps: requestedMaxSteps,
});

export const RetryRunRequestSchema = z.object({
  prompt: NonBlankStringSchema.optional(),
  maxSteps: requestedMaxSteps,
}).default({});

export type InvestigationRun = z.infer<typeof InvestigationRunSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type RetryRunRequest = z.infer<typeof RetryRunRequestSchema>;
