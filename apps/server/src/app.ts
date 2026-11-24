import { APP_NAME, HealthResponseSchema } from '@mini-agent-run/shared';
import Fastify from 'fastify';
import { checkSqliteSmoke } from './db/smoke.js';

export function buildApp() {
  const app = Fastify();

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

  return app;
}
