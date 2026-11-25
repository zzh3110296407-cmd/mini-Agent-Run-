import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { buildApp } from './app.js';
import { parseEnv, splitAllowedTraceRoots } from './config/env.js';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envPath)) {
  const { error } = config({ path: envPath, quiet: true });
  if (error) throw error;
}

const env = parseEnv(process.env);
const app = buildApp({ allowedTraceRoots: splitAllowedTraceRoots(env.ALLOWED_TRACE_ROOTS) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  const address = await app.listen({ host: '127.0.0.1', port: env.PORT });
  console.log(`Server listening at ${address}`);
} catch (error) {
  console.error(error);
  await app.close();
  process.exitCode = 1;
}
