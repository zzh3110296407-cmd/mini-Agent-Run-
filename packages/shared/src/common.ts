import { z } from 'zod';

export const MAX_INLINE_TOOL_OUTPUT_BYTES = 6144;
export const MAX_ARTIFACT_SLICE_LINES = 200;
export const DEFAULT_MAX_STEPS = 12;

export const RunStatusSchema = z.enum(['pending', 'running', 'completed', 'stopped', 'failed']);
export const StopReasonSchema = z.enum(['completed', 'user_abort', 'max_steps', 'error', 'server_restarted']);
export const PathTypeSchema = z.enum(['file', 'dir']);
export const TitleSourceSchema = z.enum(['auto', 'manual']);
export const ToolModeSchema = z.enum(['mock', 'live']);
export const LogLevelSchema = z.enum(['error', 'warn', 'info', 'other']);
export const TaskOutcomeSchema = z.enum(['passed', 'failed', 'unknown']);
export const ArtifactContentTypeSchema = z.enum(['text/plain', 'application/json', 'application/x-ndjson']);
export const IsoDateTimeSchema = z.iso.datetime();

export const SessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9_-]+$/);
export const RunIdSchema = z.string().regex(/^run_[A-Za-z0-9_-]+$/);
export const ArtifactIdSchema = z.string().regex(/^art_[A-Za-z0-9_-]+$/);
export const MessageIdSchema = z.string().regex(/^msg_[A-Za-z0-9_-]+$/);
export const ToolCallIdSchema = z.string().regex(/^tc_[A-Za-z0-9_-]+$/);
export const NonBlankStringSchema = z.string().trim().min(1);

// File names and paths can have meaningful whitespace.
export const NonBlankPathSchema = z.string().refine((value) => value.trim().length > 0, 'Expected a nonblank path.');

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;
export type PathType = z.infer<typeof PathTypeSchema>;
export type TitleSource = z.infer<typeof TitleSourceSchema>;
export type ToolMode = z.infer<typeof ToolModeSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;
export type ArtifactContentType = z.infer<typeof ArtifactContentTypeSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;
