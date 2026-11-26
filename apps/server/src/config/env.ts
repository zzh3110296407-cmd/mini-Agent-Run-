import { z } from 'zod';

export const DEFAULT_ALLOWED_TRACE_ROOTS = '*';

export function splitAllowedTraceRoots(raw: string): string[] {
  return [...new Set(raw.split(',').map((path) => path.trim()).filter(Boolean))];
}

export function isUnrestrictedTraceRoots(rawRoots: readonly string[]): boolean {
  return rawRoots.includes('*');
}

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
  ALLOWED_TRACE_ROOTS: z.string().default(DEFAULT_ALLOWED_TRACE_ROOTS).refine(
    (value) => splitAllowedTraceRoots(value).length > 0,
    { message: 'ALLOWED_TRACE_ROOTS must contain at least one non-empty path.' },
  ),
});

export const ENV_KEYS = EnvSchema.keyof().options;

export function parseEnv(rawEnv: unknown) {
  return EnvSchema.parse(rawEnv);
}
