import { APP_NAME, HealthResponseSchema } from '@mini-agent-run/shared';
import Fastify from 'fastify';
import { registerArtifactRoutes } from './artifact-routes.js';
import { DEFAULT_ALLOWED_TRACE_ROOTS, splitAllowedTraceRoots } from './config/env.js';
import { createSqliteArtifactStore } from './db/artifact-store.js';
import { openAppDatabase, recoverStaleRuns, type DatabaseOwnerLock } from './db/database.js';
import { PathSandboxError, WORKSPACE_ROOT, browseSafeDirectory, resolveAllowedRoots } from './fs/path-sandbox.js';
import { registerSessionRoutes } from './session-routes.js';

export interface BuildAppOptions {
  allowedTraceRoots?: readonly string[];
  baseDir?: string;
  dbPath?: string;
  maxFileSliceBytes?: number;
}

export function buildApp(options: BuildAppOptions = {}, ownerLock?: DatabaseOwnerLock) {
  const app = Fastify();
  const rawRoots = options.allowedTraceRoots ?? splitAllowedTraceRoots(DEFAULT_ALLOWED_TRACE_ROOTS);
  const baseDir = options.baseDir ?? WORKSPACE_ROOT;
  const resolveRoots = () => resolveAllowedRoots(rawRoots, baseDir);

  app.get('/api/health', async (_request, reply) => {
    const row = db.prepare<[], { ok: number }>('SELECT 1 AS ok').get();
    if (row?.ok !== 1) {
      return reply.code(503).send({ status: 'unavailable', sqlite: 'error' });
    }

    return HealthResponseSchema.parse({
      status: 'ok',
      service: APP_NAME,
      timestamp: new Date().toISOString(),
      sqlite: 'ok',
    });
  });

  app.get<{ Querystring: { path?: unknown } }>('/api/fs/browse', async (request, reply) => {
    try {
      const { path } = request.query;
      if (path !== undefined && typeof path !== 'string') throw new PathSandboxError('INVALID_PATH');
      return browseSafeDirectory(path, resolveRoots(), baseDir);
    } catch (error) {
      if (!(error instanceof PathSandboxError)) throw error;
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
  });

  const db = openAppDatabase(ownerLock?.dbPath ?? options.dbPath ?? ':memory:');
  try {
    const artifactStore = createSqliteArtifactStore(db);
    registerSessionRoutes(app, db, resolveRoots, { baseDir, maxFileSliceBytes: options.maxFileSliceBytes });
    registerArtifactRoutes(app, db);
    app.addHook('onClose', async () => {
      db.close();
      ownerLock?.release();
    });
    return Object.assign(app, { artifactStore, recoverStaleRuns: () => recoverStaleRuns(db) });
  } catch (error) {
    db.close();
    throw error;
  }
}
