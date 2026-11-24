import { z } from 'zod';

const PortSchema = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().min(1).max(65535));

const EnvSchema = z.object({
  PORT: PortSchema.default(3001),
  LLM_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  TOOL_MODE: z.enum(['mock', 'live']).default('mock'),
  DB_PATH: z.string().min(1).default('./data/agent-run.db'),
});

export const ENV_KEYS = EnvSchema.keyof().options;

export function parseEnv(rawEnv: unknown) {
  return EnvSchema.parse(rawEnv);
}
