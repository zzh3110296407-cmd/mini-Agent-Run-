import {
  ArtifactMetaSchema, FsBrowseResponseSchema, HealthResponseSchema, InvestigationRunSchema, RunEventEnvelopeSchema,
  RunIdSchema, RunStatusSchema, SessionDetailSchema, SessionIdSchema, SessionListItemSchema, SessionSchema,
  TextSliceResponseSchema, type ArtifactId, type CreateRunRequest, type CreateSessionRequest, type LogLevel,
  type RetryRunRequest, type RunId, type SessionId, type UpdateSessionRequest,
} from '@mini-agent-run/shared';
import { getApiKeyForRequest } from '../composables/useApiKeySettings';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Compose response wrappers from the shared schemas to keep the browser's runtime dependencies small.
const objectSchema = SessionSchema.pick({});
const textSchema = HealthResponseSchema.shape.service;
const trueSchema = SessionListItemSchema.shape.hasActiveRun.refine((value) => value === true).transform(() => true as const);
function literalText<T extends string>(value: T) {
  return textSchema.refine((text) => text === value).transform(() => value);
}

const errorSchema = objectSchema.extend({ error: objectSchema.extend({ code: textSchema, message: textSchema }) });
const unavailableSchema = objectSchema.extend({ status: literalText('unavailable'), sqlite: literalText('error') });
const sessionsSchema = objectSchema.extend({ sessions: SessionListItemSchema.array() });
const deletedSessionSchema = objectSchema.extend({ deleted: trueSchema, id: SessionIdSchema });
const artifactSliceSchema = objectSchema.extend({ artifact: ArtifactMetaSchema, slice: TextSliceResponseSchema });
const runDetailSchema = objectSchema.extend({ run: InvestigationRunSchema, events: RunEventEnvelopeSchema.array() });
const stopRunSchema = objectSchema.extend({ runId: RunIdSchema, status: literalText('stopping') }).strict()
  .or(objectSchema.extend({
    runId: RunIdSchema, status: RunStatusSchema.exclude(['pending', 'running']), alreadyTerminal: trueSchema,
  }));

type SliceQuery = { limit?: number; level?: LogLevel; q?: string };
type SessionFileQuery = SliceQuery & { startLine?: number; file?: string };
type ArtifactSliceQuery = SliceQuery & { offsetLine?: number };

function withQuery(path: string, values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const query = params.toString();
  return query === '' ? path : path + '?' + query;
}

function sessionPath(id: SessionId) { return '/api/sessions/' + encodeURIComponent(id); }
function runPath(id: RunId) { return '/api/runs/' + encodeURIComponent(id); }

type ClientOptions = { fetchImpl?: typeof fetch; getApiKey?: () => string | undefined };
type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: object; key?: string };
type ResponseSchema<T> = { parse(data: unknown): T };

export function createApiClient({
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  getApiKey,
}: ClientOptions = {}) {
  async function request<T>(url: string, schema: ResponseSchema<T>, { method = 'GET', body, key }: RequestOptions = {}) {
    let response: Response;
    try {
      const headers = new Headers();
      if (body !== undefined) headers.set('Content-Type', 'application/json');
      if (key) headers.set('X-LLM-API-Key', key);
      response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', '无法连接后端，请检查服务是否已启动。');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (response.ok) throw new ApiError(response.status, 'INVALID_RESPONSE', '后端返回了无法读取的 JSON。');
      throw new ApiError(response.status, 'HTTP_ERROR', '请求失败，请检查后端服务。');
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(data);
      if (parsed.success) {
        const { code, message } = parsed.data.error;
        const redact = (text: string) => key ? text.replaceAll(key, '[已隐藏]') : text;
        throw new ApiError(response.status, redact(code), redact(message));
      }
      if (url === '/api/health' && response.status === 503 && unavailableSchema.safeParse(data).success) {
        throw new ApiError(503, 'HEALTH_UNAVAILABLE', '后端 SQLite 健康检查未通过。');
      }
      throw new ApiError(response.status, 'HTTP_ERROR', '请求失败，请检查后端服务。');
    }
    return schema.parse(data);
  }

  return {
    getHealth: () => request('/api/health', HealthResponseSchema),
    browseFs: (path?: string, options?: { resolveFile?: boolean }) =>
      request(withQuery('/api/fs/browse', { path, resolveFile: options?.resolveFile ? 1 : undefined }), FsBrowseResponseSchema),
    listSessions: () => request('/api/sessions', sessionsSchema),
    createSession: (input: CreateSessionRequest) => request('/api/sessions', SessionSchema, { method: 'POST', body: input }),
    getSessionDetail: (id: SessionId) => request(sessionPath(id), SessionDetailSchema),
    renameSession: (id: SessionId, input: UpdateSessionRequest) =>
      request(sessionPath(id), SessionSchema, { method: 'PATCH', body: input }),
    deleteSession: (id: SessionId) => request(sessionPath(id), deletedSessionSchema, { method: 'DELETE' }),
    getSessionFileSlice: (id: SessionId, params: SessionFileQuery = {}) =>
      request(withQuery(sessionPath(id) + '/file-slice', params), TextSliceResponseSchema),
    getArtifactSlice: (id: ArtifactId, params: ArtifactSliceQuery = {}) =>
      request(withQuery('/api/artifacts/' + encodeURIComponent(id), params), artifactSliceSchema),
    startRun: (id: SessionId, input: CreateRunRequest) =>
      request(sessionPath(id) + '/runs', InvestigationRunSchema, { method: 'POST', body: input, key: getApiKey?.()?.trim() }),
    getRunDetail: (id: RunId) => request(runPath(id), runDetailSchema),
    stopRun: (id: RunId) => request(runPath(id) + '/stop', stopRunSchema, { method: 'POST' }),
    retryRun: (id: RunId, input: RetryRunRequest = {}) =>
      request(runPath(id) + '/retry', InvestigationRunSchema, { method: 'POST', body: input, key: getApiKey?.()?.trim() }),
    buildRunStreamUrl: (id: RunId, afterSeq?: number) => withQuery(runPath(id) + '/stream', { afterSeq }),
  };
}

export const apiClient = createApiClient({ getApiKey: getApiKeyForRequest });
