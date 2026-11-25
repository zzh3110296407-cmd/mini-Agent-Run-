import { ArtifactIdSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES } from '@mini-agent-run/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
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
  function readArtifact(rawId: string, rawQuery: unknown, reply: FastifyReply) {
    const id = ArtifactIdSchema.safeParse(rawId);
    const query = artifactSliceQuery.safeParse(rawQuery);
    if (!id.success || !query.success) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'The Artifact request is invalid.' } });
    }
    const result = getArtifactWithSlice(db, id.data, query.data);
    if (!result) {
      return reply.code(404).send({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'The Artifact does not exist.' } });
    }
    return result;
  }

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) =>
    readArtifact(request.params.id, request.query, reply));

  // The wildcard lets longer IDs reach the same schema without changing the router's global limit.
  app.get<{ Params: { '*': string } }>('/api/artifacts/*', async (request, reply) => {
    const id = request.params['*'];
    if (id.includes('/')) {
      // Encoded slashes belong to the ID. Literal slashes separate route segments.
      const [pathname = ''] = request.url.split(/[?#]/, 1);
      const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
      if (decodeURIComponent(lastSegment) !== id) return reply.callNotFound();
    }
    return readArtifact(id, request.query, reply);
  });
}
