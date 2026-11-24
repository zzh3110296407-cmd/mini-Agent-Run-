import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
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

export function loadWorkspaceEnv() {
  const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
  const envPath = resolve(workspace, '.env');
  if (existsSync(envPath)) {
    const { error } = config({ path: envPath, quiet: true });
    if (error) throw error;
  }
  const env = parseEnv(process.env);
  return { ...env, DB_PATH: resolve(workspace, env.DB_PATH) };
}
