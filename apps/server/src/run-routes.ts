import {
  CreateRunRequestSchema, RetryRunRequestSchema, RunIdSchema, SessionIdSchema, type RunEventEnvelope,
} from '@mini-agent-run/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import { z } from 'zod';
import { RunCoordinatorError } from './runtime/ports.js';
import type { createRunCoordinator, RunStream } from './runtime/run-coordinator.js';

class InvalidRunRequest extends Error {}

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new InvalidRunRequest();
  return parsed.data;
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers[name];
  if (header === undefined) return;
  if (typeof header !== 'string') throw new InvalidRunRequest();
  const raw = request.raw.rawHeaders;
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name && ++count > 1) throw new InvalidRunRequest();
  }
  return header.trim();
}

const sequence = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).optional();
type ById = { Params: { id: string } };
type RunHandler = (id: string, request: FastifyRequest, reply: FastifyReply) => unknown;

function renderFrame(envelope: RunEventEnvelope) {
  return 'id: ' + envelope.seq + '\nevent: ' + envelope.event.type + '\ndata: ' + JSON.stringify(envelope) + '\n\n';
}

async function sendStream(request: FastifyRequest, reply: FastifyReply, stream: RunStream, heartbeatMs: number) {
  const raw = reply.raw;
  const disconnected = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  function cleanup() {
    disconnected.abort();
    clearInterval(timer);
    stream.close();
  }
  function requestClosed() {
    if (!request.raw.complete) cleanup();
  }

  reply.hijack();
  raw.on('close', cleanup);
  raw.on('error', cleanup);
  request.raw.on('close', requestClosed);
  try {
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    raw.flushHeaders?.();
    timer = setInterval(() => {
      if (!raw.writableNeedDrain && !raw.destroyed) raw.write(': ping\n\n');
    }, heartbeatMs);
    for await (const envelope of stream) {
      if (raw.destroyed || disconnected.signal.aborted) break;
      if (!raw.write(renderFrame(envelope))) await once(raw, 'drain', { signal: disconnected.signal });
    }
  } catch {
    if (!raw.destroyed) raw.destroy();
  } finally {
    cleanup();
    raw.off('close', cleanup);
    raw.off('error', cleanup);
    request.raw.off('close', requestClosed);
    if (!raw.destroyed) raw.end();
  }
}

function longId(request: FastifyRequest, prefix: string, suffix: string): string | undefined {
  const [path = ''] = request.url.split(/[?#]/, 1);
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return;
  const segment = path.slice(prefix.length, path.length - suffix.length);
  if (!segment || segment.includes('/')) return;
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InvalidRunRequest();
  }
}

export function registerRunRoutes(
  app: FastifyInstance, coordinator: ReturnType<typeof createRunCoordinator>, heartbeatMs = 15_000,
) {
  app.register(async (routes) => {
    const parseJson = routes.getDefaultJsonParser('error', 'error');
    routes.removeContentTypeParser('application/json');
    routes.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
      const json = typeof body === 'string' ? body : body.toString('utf8');
      if (json === '') done(null, undefined);
      else parseJson(request, json, done);
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof RunCoordinatorError) {
        return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      }
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      if (error instanceof InvalidRunRequest || statusCode === 400 || statusCode === 415) {
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'The run request is invalid.' } });
      }
      const status = statusCode === 413 ? 413 : 500;
      return reply.code(status).send({ error: {
        code: status === 413 ? 'INVALID_REQUEST' : 'RUN_REQUEST_FAILED',
        message: status === 413 ? 'The run request is too large.' : 'The run request could not be completed.',
      } });
    });

    const start: RunHandler = (id, request, reply) => {
      const input = parse(CreateRunRequestSchema, request.body);
      const apiKeyOverride = singleHeader(request, 'x-llm-api-key');
      return reply.code(201).send(coordinator.startRun(parse(SessionIdSchema, id), input, { apiKeyOverride }));
    };
    const detail: RunHandler = (id) => coordinator.getRunDetail(parse(RunIdSchema, id));
    const stream: RunHandler = (id, request, reply) => {
      const query = parse(z.object({ afterSeq: sequence }), request.query);
      const header = parse(sequence, singleHeader(request, 'last-event-id'));
      const subscription = coordinator.subscribeRunStream(parse(RunIdSchema, id), header ?? query.afterSeq ?? 0);
      return sendStream(request, reply, subscription, heartbeatMs);
    };
    const stop: RunHandler = (id, _request, reply) => {
      const result = coordinator.stopRun(parse(RunIdSchema, id));
      return reply.code('alreadyTerminal' in result ? 200 : 202).send(result);
    };
    const retry: RunHandler = (id, request, reply) => {
      const input = parse(RetryRunRequestSchema, request.body);
      const apiKeyOverride = singleHeader(request, 'x-llm-api-key');
      return reply.code(201).send(coordinator.retryRun(parse(RunIdSchema, id), input, { apiKeyOverride }));
    };

    routes.post<ById>('/api/sessions/:id/runs', async (request, reply) => start(request.params.id, request, reply));
    routes.get<ById>('/api/runs/:id', async (request, reply) => detail(request.params.id, request, reply));
    routes.get<ById>('/api/runs/:id/stream', { exposeHeadRoute: false }, async (request, reply) =>
      stream(request.params.id, request, reply));
    routes.post<ById>('/api/runs/:id/stop', async (request, reply) => stop(request.params.id, request, reply));
    routes.post<ById>('/api/runs/:id/retry', async (request, reply) => retry(request.params.id, request, reply));

    // The router declines overlong parameters. Match the same single raw path segment through the wildcard.
    routes.post('/api/sessions/*', async (request, reply) => {
      const id = longId(request, '/api/sessions/', '/runs');
      return id === undefined ? reply.callNotFound() : start(id, request, reply);
    });
    routes.get('/api/runs/*', { exposeHeadRoute: false }, async (request, reply) => {
      const streamId = longId(request, '/api/runs/', '/stream');
      if (streamId !== undefined) return stream(streamId, request, reply);
      const id = longId(request, '/api/runs/', '');
      return id === undefined ? reply.callNotFound() : detail(id, request, reply);
    });
    routes.post('/api/runs/*', async (request, reply) => {
      const stopId = longId(request, '/api/runs/', '/stop');
      if (stopId !== undefined) return stop(stopId, request, reply);
      const retryId = longId(request, '/api/runs/', '/retry');
      return retryId === undefined ? reply.callNotFound() : retry(retryId, request, reply);
    });
  });
}
