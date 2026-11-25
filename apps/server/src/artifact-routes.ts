import { ArtifactIdSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES } from '@mini-agent-run/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getArtifactWithSlice } from './db/artifact-store.js';

const positiveInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());
const artifactSliceQuery = z.object({
  offsetLine: positiveInteger.default(1),
  limit: positiveInteger.pipe(z.number().max(MAX_ARTIFACT_SLICE_LINES)).default(MAX_ARTIFACT_SLICE_LINES),
  level: LogLevelSchema.optional(),
  q: z.string().optional(),
});

export function registerArtifactRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const id = ArtifactIdSchema.safeParse(request.params.id);
    const query = artifactSliceQuery.safeParse(request.query);
    if (!id.success || !query.success) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'The Artifact request is invalid.' } });
    }
    const result = getArtifactWithSlice(db, id.data, query.data);
    if (!result) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'The Artifact does not exist.' } });
    }
    return result;
  });
}
