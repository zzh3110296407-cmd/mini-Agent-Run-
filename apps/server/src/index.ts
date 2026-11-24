import { buildApp } from './app.js';
import { loadWorkspaceEnv } from './config/env.js';
import { createTrajectoryTools } from './db/trajerrbench.js';

const { PORT, DB_PATH } = loadWorkspaceEnv();
const app = buildApp(createTrajectoryTools(DB_PATH));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  const address = await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`Server listening at ${address}`);
} catch (error) {
  console.error(error);
  await app.close();
  process.exitCode = 1;
}
