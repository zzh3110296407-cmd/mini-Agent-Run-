import {
  CreateSessionRequestSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES, SessionIdSchema, UpdateSessionRequestSchema,
} from '@mini-agent-run/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createSession, deleteSession, getSession, getSessionDetail, listSessions, renameSession,
} from './db/session-repository.js';
import { sliceTextContent } from './fs/file-slice.js';
import { PathSandboxError, readSafeSessionFile, resolveSessionTargetPath } from './fs/path-sandbox.js';

const errors = {
  INVALID_REQUEST: [400, 'The session request is invalid.'],
  SESSION_NOT_FOUND: [404, 'The session does not exist.'],
  SESSION_HAS_ACTIVE_RUN: [409, 'A session with an active run cannot be deleted.'],
} as const;

class SessionRequestError extends Error {
  readonly statusCode: (typeof errors)[keyof typeof errors][0];

  constructor(readonly code: keyof typeof errors) {
    const [statusCode, message] = errors[code];
    super(message);
    this.statusCode = statusCode;
  }
}

const positiveInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());
const fileSliceQuery = z.object({
  startLine: positiveInteger.default(1),
  limit: positiveInteger.pipe(z.number().max(MAX_ARTIFACT_SLICE_LINES)).default(MAX_ARTIFACT_SLICE_LINES),
  file: z.string().optional(),
  level: LogLevelSchema.optional(),
  q: z.string().optional(),
});

function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new SessionRequestError('INVALID_REQUEST');
  return result.data;
}

type ById = { Params: { id: string } };

export function registerSessionRoutes(
  app: FastifyInstance, db: Database.Database, resolveRoots: () => string[],
  { baseDir, maxFileSliceBytes }: { baseDir: string; maxFileSliceBytes?: number },
) {
  app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const problem = code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
        ? new SessionRequestError('INVALID_REQUEST') : error;
      if (problem instanceof SessionRequestError || problem instanceof PathSandboxError) {
        return reply.code(problem.statusCode).send({ error: { code: problem.code, message: problem.message } });
      }
      throw error;
    });

    routes.post('/api/sessions', async (request, reply) => {
      const input = parseRequest(CreateSessionRequestSchema, request.body);
      const target = resolveSessionTargetPath(input.targetPath, resolveRoots(), baseDir);
      return reply.code(201).send(createSession(db, {
        targetPath: target.realPath, pathType: target.kind, title: input.title,
      }));
    });

    routes.get('/api/sessions', async () => ({ sessions: listSessions(db) }));

    routes.get<ById>('/api/sessions/:id', async (request) => {
      const detail = getSessionDetail(db, parseRequest(SessionIdSchema, request.params.id));
      if (!detail) throw new SessionRequestError('SESSION_NOT_FOUND');
      return detail;
    });

    routes.patch<ById>('/api/sessions/:id', async (request) => {
      const id = parseRequest(SessionIdSchema, request.params.id);
      const { title } = parseRequest(UpdateSessionRequestSchema, request.body);
      const session = renameSession(db, id, title);
      if (!session) throw new SessionRequestError('SESSION_NOT_FOUND');
      return session;
    });

    routes.delete<ById>('/api/sessions/:id', async (request) => {
      const id = parseRequest(SessionIdSchema, request.params.id);
      const result = deleteSession(db, id);
      if (result === 'not_found') throw new SessionRequestError('SESSION_NOT_FOUND');
      if (result === 'active_run') throw new SessionRequestError('SESSION_HAS_ACTIVE_RUN');
      return { deleted: true, id };
    });

    routes.get<ById>('/api/sessions/:id/file-slice', async (request) => {
      const session = getSession(db, parseRequest(SessionIdSchema, request.params.id));
      if (!session) throw new SessionRequestError('SESSION_NOT_FOUND');
      const { startLine, file, limit, level, q } = parseRequest(fileSliceQuery, request.query);
      const content = readSafeSessionFile(session, file, resolveRoots(), { baseDir, maxBytes: maxFileSliceBytes });
      return sliceTextContent(content, { offsetLine: startLine, limit, level, q });
    });
  });
}
