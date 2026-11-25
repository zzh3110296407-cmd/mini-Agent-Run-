import { buildApp, type BuildAppOptions } from './app.js';
import { acquireDatabaseOwnerLock } from './db/database.js';

export async function startServer({ port, ...options }: BuildAppOptions & { port: number }) {
  const ownerLock = acquireDatabaseOwnerLock(options.dbPath ?? ':memory:');
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    app = buildApp(options, ownerLock);
    const address = await app.listen({ host: '127.0.0.1', port });
    app.recoverStaleRuns();
    return { app, address };
  } catch (error) {
    if (app) await app.close();
    else ownerLock.release();
    throw error;
  }
}
