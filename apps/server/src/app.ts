import { createOpenAICompatibleProvider, type LLMProvider } from '@mini-agent-run/ai';
import { APP_NAME, HealthResponseSchema, type ToolMode } from '@mini-agent-run/shared';
import Fastify from 'fastify';
import { registerArtifactRoutes } from './artifact-routes.js';
import { DEFAULT_ALLOWED_TRACE_ROOTS, splitAllowedTraceRoots } from './config/env.js';
import { createSqliteArtifactStore } from './db/artifact-store.js';
import { openAppDatabase, recoverStaleRuns, type DatabaseOwnerLock } from './db/database.js';
import { createSqliteRunStore } from './db/run-repository.js';
import { PathSandboxError, WORKSPACE_ROOT, browseSafeDirectory, resolveAllowedRoots } from './fs/path-sandbox.js';
import { createServerTraceWorkspace } from './fs/trace-workspace.js';
import { registerRunRoutes } from './run-routes.js';
import { RunCoordinatorError, type RunProviderResolver } from './runtime/ports.js';
import { createRunCoordinator } from './runtime/run-coordinator.js';
import { createRunRedactor } from './runtime/run-redaction.js';
import { registerSessionRoutes } from './session-routes.js';

export interface BuildAppOptions {
  allowedTraceRoots?: readonly string[];
  baseDir?: string;
  dbPath?: string;
  maxFileSliceBytes?: number;
  toolMode?: ToolMode;
  llmConfig?: { baseUrl?: string; model?: string; apiKey?: string; providerName?: string };
  llmProvider?: LLMProvider;
  llmFetch?: typeof fetch;
  coalesceWindowMs?: number;
  coalesceMaxChars?: number;
  sseHeartbeatMs?: number;
  diagnosticsDefaultDelayMs?: number;
  diagnosticsProgressIntervalMs?: number;
  contextWindowTokens?: number;
}

function resolveRunProvider({ llmConfig, llmProvider, llmFetch }: BuildAppOptions): RunProviderResolver {
  return (apiKeyOverride) => {
    const defaultKey = llmConfig?.apiKey?.trim();
    const candidates = [apiKeyOverride, defaultKey].filter((key): key is string => Boolean(key && key !== 'your_api_key_here'));
    const redactor = candidates.length ? createRunRedactor(candidates) : undefined;
    const model = llmConfig?.model?.trim();
    if (llmProvider) {
      return { provider: llmProvider, modelId: model || 'mock', providerName: llmProvider.name, redactor };
    }

    const apiKey = candidates[0];
    const baseUrl = llmConfig?.baseUrl;
    if (!apiKey || !baseUrl || !model) throw new RunCoordinatorError('LLM_NOT_CONFIGURED');
    try {
      const provider = createOpenAICompatibleProvider({
        baseUrl, apiKey, providerName: llmConfig?.providerName, fetchImpl: llmFetch,
      });
      return { provider, modelId: model, providerName: provider.name, redactor };
    } catch {
      throw new RunCoordinatorError('LLM_NOT_CONFIGURED');
    }
  };
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
    const coordinator = createRunCoordinator({
      store: createSqliteRunStore(db), artifactStore,
      createWorkspace: (session) => createServerTraceWorkspace(session, { baseDir, maxFileSliceBytes: options.maxFileSliceBytes }),
      resolveProvider: resolveRunProvider(options), resolveAllowedRoots: resolveRoots, toolMode: options.toolMode ?? 'mock',
      coalesceWindowMs: options.coalesceWindowMs, coalesceMaxChars: options.coalesceMaxChars,
      diagnosticsDefaultDelayMs: options.diagnosticsDefaultDelayMs,
      diagnosticsProgressIntervalMs: options.diagnosticsProgressIntervalMs, contextWindowTokens: options.contextWindowTokens,
    });
    registerSessionRoutes(app, db, resolveRoots, { baseDir, maxFileSliceBytes: options.maxFileSliceBytes });
    registerArtifactRoutes(app, db);
    registerRunRoutes(app, coordinator, options.sseHeartbeatMs);
    // Active SSE connections can keep the HTTP server open until their runs settle.
    app.addHook('preClose', () => coordinator.shutdown());
    app.addHook('onClose', async () => {
      await coordinator.shutdown();
      try { db.close(); } finally { ownerLock?.release(); }
    });
    return Object.assign(app, { artifactStore, runCoordinator: coordinator, recoverStaleRuns: () => recoverStaleRuns(db) });
  } catch (error) {
    db.close();
    throw error;
  }
}
