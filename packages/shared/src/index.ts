import { z } from 'zod';

export const APP_NAME = 'mini-agent-run';

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  timestamp: z.string(),
  sqlite: z.literal('ok'),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
