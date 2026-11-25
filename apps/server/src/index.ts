import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { parseEnv, splitAllowedTraceRoots } from './config/env.js';
import { WORKSPACE_ROOT } from './fs/path-sandbox.js';
import { startServer } from './start-server.js';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envPath)) {
  const { error } = config({ path: envPath, quiet: true });
  if (error) throw error;
}

const env = parseEnv(process.env);
const dbPath = env.DB_PATH === ':memory:' ? env.DB_PATH : resolve(WORKSPACE_ROOT, env.DB_PATH);

try {
  const { app, address } = await startServer({
    dbPath, port: env.PORT, allowedTraceRoots: splitAllowedTraceRoots(env.ALLOWED_TRACE_ROOTS),
    toolMode: env.TOOL_MODE,
    llmConfig: { baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY, providerName: 'deepseek' },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  }
  console.log(`Server listening at ${address}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
