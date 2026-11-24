import {
  APP_NAME,
  HealthResponseSchema,
  MAX_TRAJECTORY_RUN_ID_LENGTH,
  type TrajectoryTools,
} from '@mini-agent-run/shared';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { checkSqliteSmoke } from './db/smoke.js';
import { TrajectoryDatasetUnavailable } from './db/trajerrbench.js';

export function buildApp(trajectoryTools?: TrajectoryTools) {
  const app = Fastify({ routerOptions: { maxParamLength: MAX_TRAJECTORY_RUN_ID_LENGTH } });

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

  if (trajectoryTools) {
    app.register(async (routes) => {
      routes.setErrorHandler((error, request, reply) => {
        if (error instanceof ZodError) return reply.code(400).send({ error: 'Invalid trajectory query.' });
        if (error instanceof TrajectoryDatasetUnavailable) {
          return reply.code(503).send({ error: error.message });
        }
        request.log.error(error);
        return reply.code(500).send({ error: 'Trajectory lookup failed.' });
      });

      routes.get('/runs', async (request) => trajectoryTools.listRuns(request.query));
      routes.get('/search', async (request) => trajectoryTools.searchRuntimeLogs(request.query));
      routes.get<{ Params: { runId: string }; Querystring: Record<string, unknown> }>(
        '/runs/:runId',
        async (request, reply) => {
          const result = trajectoryTools.getRunDetail({ ...request.query, ...request.params });
          return result ?? reply.code(404).send({ error: 'Trajectory run not found.' });
        },
      );
      routes.get<{ Params: { runId: string; step: string }; Querystring: Record<string, unknown> }>(
        '/runs/:runId/logs/:step',
        async (request, reply) => {
          const result = trajectoryTools.readRuntimeLog({ ...request.query, ...request.params });
          return result ?? reply.code(404).send({ error: 'Trajectory log position not found.' });
        },
      );
    }, { prefix: '/api/datasets/trajerrbench' });
  }

  return app;
}
