import { APP_NAME, HealthResponseSchema } from '@mini-agent-run/shared';
import Fastify from 'fastify';
import { DEFAULT_ALLOWED_TRACE_ROOTS, splitAllowedTraceRoots } from './config/env.js';
import { checkSqliteSmoke } from './db/smoke.js';
import { PathSandboxError, WORKSPACE_ROOT, browseSafeDirectory, resolveAllowedRoots } from './fs/path-sandbox.js';

export interface BuildAppOptions {
  allowedTraceRoots?: readonly string[];
  baseDir?: string;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify();
  const rawRoots = options.allowedTraceRoots ?? splitAllowedTraceRoots(DEFAULT_ALLOWED_TRACE_ROOTS);
  const baseDir = options.baseDir ?? WORKSPACE_ROOT;

  app.get('/api/health', async (_request, reply) => {
    if (!checkSqliteSmoke()) {
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
      const roots = resolveAllowedRoots(rawRoots, baseDir);
      return browseSafeDirectory(path, roots, baseDir);
    } catch (error) {
      if (!(error instanceof PathSandboxError)) throw error;
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
  });

  return app;
}
