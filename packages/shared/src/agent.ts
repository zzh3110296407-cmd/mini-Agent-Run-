import { z } from 'zod';
import {
  ArtifactIdSchema, IsoDateTimeSchema, MessageIdSchema, NonBlankStringSchema, RunIdSchema,
  RunStatusSchema, SessionIdSchema, StopReasonSchema, TaskOutcomeSchema, ToolCallIdSchema,
} from './common.js';

const nonnegative = z.number().int().min(0);
const positive = z.number().int().min(1);
const toolName = NonBlankStringSchema;
const toolArguments = z.record(z.string(), z.unknown());

export const ToolCallRequestSchema = z.object({
  id: ToolCallIdSchema,
  name: toolName,
  arguments: toolArguments,
});

export const ToolOutputSummarySchema = z.object({
  byteSize: nonnegative,
  lineCount: nonnegative,
  truncatedForLlm: z.boolean(),
  levelCounts: z.object({ error: nonnegative, warn: nonnegative, info: nonnegative, other: nonnegative }),
  firstErrorLine: positive.nullable(),
  previewHead: z.string(),
  previewTail: z.string().optional(),
});

const message = z.object({ id: MessageIdSchema, content: z.string(), createdAt: IsoDateTimeSchema });
const assistantMessage = message.extend({
  role: z.literal('assistant'),
  toolCalls: z.array(ToolCallRequestSchema),
  stopReason: z.enum(['stop', 'tool_calls', 'aborted', 'error']).optional(),
});

export const AgentMessageSchema = z.discriminatedUnion('role', [
  message.extend({ role: z.literal('user') }),
  assistantMessage,
  message.extend({
    role: z.literal('toolResult'),
    toolCallId: ToolCallIdSchema,
    toolName,
    isError: z.boolean(),
    durationMs: nonnegative,
    artifactId: ArtifactIdSchema.optional(),
    summary: ToolOutputSummarySchema.optional(),
  }),
]);

export const PendingToolCallSchema = z.object({
  toolCallId: ToolCallIdSchema,
  toolName,
  startedAt: IsoDateTimeSchema,
});

export const AgentErrorSchema = z.object({
  code: NonBlankStringSchema,
  message: NonBlankStringSchema,
});

export const AgentStateSchema = z.object({
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  status: RunStatusSchema,
  systemPrompt: z.string(),
  model: z.object({ provider: NonBlankStringSchema, modelId: NonBlankStringSchema }),
  messages: z.array(AgentMessageSchema),
  pendingToolCalls: z.array(PendingToolCallSchema),
  step: nonnegative,
  maxSteps: positive,
  stopReason: StopReasonSchema.nullable(),
  error: AgentErrorSchema.nullable(),
});

const evidence = z.object({ label: NonBlankStringSchema, excerpt: z.string().optional() });
const lineEvidence = evidence.extend({ startLine: positive, endLine: positive.optional() });

export const EvidenceRefSchema = z.discriminatedUnion('kind', [
  evidence.extend({ kind: z.literal('file_step'), file: NonBlankStringSchema, step: nonnegative }),
  lineEvidence.extend({ kind: z.literal('file_line'), file: NonBlankStringSchema }),
  lineEvidence.extend({ kind: z.literal('artifact_line'), artifactId: ArtifactIdSchema }),
]).refine(
  (entry) => entry.kind === 'file_step' || entry.endLine === undefined || entry.endLine >= entry.startLine,
  { path: ['endLine'], message: 'endLine must be at or after startLine.' },
);

export const ErrorLineSummarySchema = z.object({
  file: NonBlankStringSchema.optional(),
  artifactId: ArtifactIdSchema.optional(),
  line: positive,
  summary: NonBlankStringSchema,
});

export const InvestigationConclusionSchema = z.object({
  summary: NonBlankStringSchema,
  rootCauseStep: nonnegative.nullable().optional(),
  rootCauseCategory: NonBlankStringSchema.nullable().optional(),
  threeStateAssessment: z.object({
    terminationReason: NonBlankStringSchema.optional(),
    hasToolError: z.boolean().optional(),
    taskOutcome: TaskOutcomeSchema.optional(),
  }).optional(),
  evidence: z.array(EvidenceRefSchema),
  recommendations: z.array(NonBlankStringSchema),
  errorSummaries: z.array(ErrorLineSummarySchema).optional(),
});

const toolEvent = z.object({ toolCallId: ToolCallIdSchema, toolName });

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent_start'),
    sessionId: SessionIdSchema,
    prompt: NonBlankStringSchema,
    modelId: NonBlankStringSchema,
    maxSteps: positive,
  }),
  z.object({ type: z.literal('turn_start'), step: positive }),
  z.object({ type: z.literal('message_start'), messageId: MessageIdSchema, role: z.literal('assistant') }),
  z.object({
    type: z.literal('message_update'),
    messageId: MessageIdSchema,
    deltaType: z.enum(['text_delta', 'toolcall_delta']),
    delta: z.string(),
    toolCallId: ToolCallIdSchema.optional(),
    toolName: toolName.optional(),
  }),
  z.object({ type: z.literal('message_end'), message: assistantMessage }),
  toolEvent.extend({ type: z.literal('tool_execution_start'), step: positive, arguments: toolArguments }),
  toolEvent.extend({
    type: z.literal('tool_execution_update'),
    elapsedMs: nonnegative,
    progressMessage: z.string().optional(),
  }),
  toolEvent.extend({
    type: z.literal('tool_execution_end'),
    step: positive,
    isError: z.boolean(),
    durationMs: nonnegative,
    preview: z.string(),
    artifactId: ArtifactIdSchema.optional(),
    summary: ToolOutputSummarySchema.optional(),
  }),
  z.object({ type: z.literal('turn_end'), step: positive, toolCallCount: nonnegative }),
  z.object({
    type: z.literal('agent_end'),
    status: z.enum(['completed', 'stopped', 'failed']),
    stopReason: StopReasonSchema,
    durationMs: nonnegative,
    finalAnswer: z.string().optional(),
    conclusion: InvestigationConclusionSchema.optional(),
    error: AgentErrorSchema.optional(),
  }),
]);

export const RunEventEnvelopeSchema = z.object({
  seq: positive,
  runId: RunIdSchema,
  timestamp: IsoDateTimeSchema,
  event: AgentEventSchema,
});

export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export type ToolOutputSummary = z.infer<typeof ToolOutputSummarySchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type PendingToolCall = z.infer<typeof PendingToolCallSchema>;
export type AgentError = z.infer<typeof AgentErrorSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type ErrorLineSummary = z.infer<typeof ErrorLineSummarySchema>;
export type InvestigationConclusion = z.infer<typeof InvestigationConclusionSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type RunEventEnvelope = z.infer<typeof RunEventEnvelopeSchema>;
