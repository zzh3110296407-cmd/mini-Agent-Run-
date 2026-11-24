import { z } from 'zod';
import {
  IsoDateTimeSchema, NonBlankStringSchema, PathTypeSchema, SessionIdSchema, TitleSourceSchema,
} from './common.js';
import { InvestigationRunSchema } from './run.js';

export const SessionSchema = z.object({
  id: SessionIdSchema,
  title: NonBlankStringSchema,
  titleSource: TitleSourceSchema,
  targetPath: NonBlankStringSchema,
  pathType: PathTypeSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const CreateSessionRequestSchema = z.object({
  targetPath: NonBlankStringSchema,
  title: NonBlankStringSchema.optional(),
});

export const UpdateSessionRequestSchema = z.object({ title: NonBlankStringSchema });

export const SessionListItemSchema = SessionSchema.extend({
  hasActiveRun: z.boolean(),
  runCount: z.number().int().min(0),
});

export const SessionDetailSchema = z.object({
  session: SessionSchema,
  hasActiveRun: z.boolean(),
  runs: z.array(InvestigationRunSchema),
});

export type Session = z.infer<typeof SessionSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
