import { RunEventEnvelopeSchema, type AgentEvent, type ArtifactId, type InvestigationRun,
  type RunId, type SessionDetail, type SessionId } from '@mini-agent-run/shared';
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { ApiError, apiClient } from '../api/client';
import { applyRunEventEnvelope, createRunTurnViewModel, isActiveRunStatus, type RunTurnViewModel } from '../utils/runTimelineReducer';

export type InspectorTargetRequest =
  | { mode: 'artifact'; artifactId: ArtifactId; line?: number; endLine?: number; label?: string }
  | { mode: 'file'; sessionId: SessionId; file?: string; line?: number; endLine?: number; step?: number; label?: string };

export type RunEventSource = {
  addEventListener(type: string, listener: EventListener): void;
  onerror: EventListener | null;
  close(): void;
};
export type EventSourceFactory = (url: string) => RunEventSource;
export type RunStreamClient = Pick<typeof apiClient, 'getRunDetail' | 'startRun' | 'retryRun' | 'stopRun' | 'buildRunStreamUrl'>;
export type SessionRunPatch = { hasActiveRun?: boolean; runCount?: number };
export type RunIssue = { code: string; message: string };
type RetryEditTarget = { runId: RunId; prompt: string };

type Options = {
  sessionId: Readonly<Ref<SessionId | null>>;
  sessionDetail: Readonly<Ref<SessionDetail | null>>;
  client?: RunStreamClient;
  eventSourceFactory?: EventSourceFactory;
  reconnectDelayMs?: number | ((attempt: number) => number);
  maxReconnectAttempts?: number;
  refreshSession?: (sessionId: SessionId) => Promise<unknown>;
  syncSessionRunState?: (sessionId: SessionId, patch: SessionRunPatch) => void;
};

const events: readonly AgentEvent['type'][] = [
  'agent_start', 'turn_start', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'turn_end', 'agent_end',
];
const retryDelays = [300, 600, 1200, 2400, 4000];

function errorIssue(error: unknown, fallback: string): RunIssue {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'SESSION_HAS_ACTIVE_RUN') {
      return { code: error.code, message: '当前会话已有运行中的排查任务，已同步最新状态。' };
    }
    if (error.status === 409 && error.code === 'RETRY_LIMIT_EXCEEDED') {
      return { code: error.code, message: '该任务已达到最大重试次数（3 次），请发起新提问继续排查。' };
    }
    if (error.status === 503 && error.code === 'LLM_NOT_CONFIGURED') {
      return { code: error.code, message: '尚未配置可用的模型 API Key。' };
    }
    return { code: error.code, message: error.code === 'NETWORK_ERROR' ? error.message : fallback };
  }
  return { code: 'REQUEST_FAILED', message: fallback };
}

function sortTurns(turns: RunTurnViewModel[]) {
  return turns.sort((first, second) => first.run.createdAt.localeCompare(second.run.createdAt));
}

export function useRunStream({
  sessionId, sessionDetail, client = apiClient, eventSourceFactory = (url) => new globalThis.EventSource(url),
  reconnectDelayMs = (attempt) => retryDelays[attempt - 1] ?? 4000, maxReconnectAttempts = 5,
  refreshSession, syncSessionRunState,
}: Options) {
  const turns = shallowRef<RunTurnViewModel[]>([]);
  const activeRun = computed(() => turns.value.find(({ run }) => isActiveRunStatus(run.status))?.run ?? null);
  const loadingHistory = ref(false);
  const historyError = ref(false);
  const sending = ref(false);
  const stoppingRunId = ref<RunId | null>(null);
  const retryEditTarget = shallowRef<RetryEditTarget | null>(null);
  const issue = shallowRef<RunIssue | null>(null);
  const reconnectingRunId = ref<RunId | null>(null);
  const reconnectAttempts = ref(0);
  const reconnectExhausted = ref(false);
  const now = ref(Date.now());
  const elapsedMs = computed(() => {
    const run = activeRun.value;
    if (!run) return 0;
    const then = Date.parse(run.startedAt ?? run.createdAt);
    return Number.isFinite(then) ? Math.max(0, now.value - then) : 0;
  });

  let currentSession: SessionId | null = null;
  let sessionToken = 0;
  let historyToken = 0;
  let socket: { id: RunId; source: RunEventSource } | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const hydrated = new Set<RunId>();

  function closeSocket() {
    const previous = socket;
    socket = undefined;
    previous?.source.close();
  }

  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    reconnectingRunId.value = null;
    reconnectAttempts.value = 0;
    reconnectExhausted.value = false;
  }

  function runView(id: RunId) { return turns.value.find(({ run }) => run.id === id); }

  function publish() {
    if (currentSession === null) return;
    syncSessionRunState?.(currentSession, { hasActiveRun: activeRun.value !== null, runCount: turns.value.length });
  }

  function writeTurn(view: RunTurnViewModel) {
    const previous = runView(view.run.id);
    turns.value = previous
      ? turns.value.map((item) => item === previous ? view : item)
      : sortTurns([...turns.value, view]);
    if (!isActiveRunStatus(view.run.status) && previous && isActiveRunStatus(previous.run.status)) {
      if (socket?.id === view.run.id) closeSocket();
      if (reconnectingRunId.value === view.run.id) clearReconnect();
      if (stoppingRunId.value === view.run.id) stoppingRunId.value = null;
      publish();
    }
  }

  function installSnapshot(snapshot: Awaited<ReturnType<RunStreamClient['getRunDetail']>>) {
    const current = runView(snapshot.run.id);
    const next = createRunTurnViewModel(snapshot.run, snapshot.events);
    hydrated.add(snapshot.run.id);
    if (!current || next.lastSeq >= current.lastSeq) {
      if (current && !isActiveRunStatus(current.run.status) && isActiveRunStatus(next.run.status)) return;
      writeTurn(next);
    } else if (isActiveRunStatus(current.run.status) && !isActiveRunStatus(next.run.status)) {
      writeTurn({
        ...current, run: next.run, activeTool: null,
        streamText: next.run.finalAnswer ?? current.streamText,
        conclusion: next.conclusion ?? current.conclusion, error: next.error,
      });
    }
  }

  async function fetchSnapshot(id: RunId, accept: () => boolean) {
    const detail = await client.getRunDetail(id);
    if (!accept()) return;
    if (detail.run.id !== id || detail.run.sessionId !== currentSession) throw new Error('Run detail identity mismatch.');
    installSnapshot(detail);
  }

  function scheduleReconnect(id: RunId, token: number) {
    const run = runView(id)?.run;
    if (sessionToken !== token || !run || !isActiveRunStatus(run.status)) return;
    reconnectingRunId.value = id;
    const exhausted = reconnectAttempts.value >= maxReconnectAttempts;
    if (!exhausted) reconnectAttempts.value++;
    const accept = () => sessionToken === token && reconnectingRunId.value === id;

    async function recover() {
      reconnectTimer = undefined;
      if (!accept()) return;
      try {
        await fetchSnapshot(id, accept);
      } catch {
        // Resume from the last accepted frame when the snapshot is also temporarily unavailable.
      }
      if (!accept()) return;
      if (exhausted) {
        reconnectExhausted.value = true;
        if (stoppingRunId.value === id) stoppingRunId.value = null;
      } else connect(id);
    }

    const delay = typeof reconnectDelayMs === 'function' ? reconnectDelayMs(reconnectAttempts.value) : reconnectDelayMs;
    if (exhausted || delay <= 0) void recover();
    else reconnectTimer = setTimeout(() => { void recover(); }, delay);
  }

  function connect(id: RunId) {
    const current = runView(id);
    if (!current || !isActiveRunStatus(current.run.status) || socket?.id === id) return;
    if (socket) closeSocket();
    const token = sessionToken;
    let source: RunEventSource;
    try {
      source = eventSourceFactory(client.buildRunStreamUrl(id, current.lastSeq));
    } catch {
      scheduleReconnect(id, token);
      return;
    }
    socket = { id, source };

    const receive: EventListener = (message) => {
      if (socket?.source !== source || token !== sessionToken || !('data' in message) || typeof message.data !== 'string') return;
      let data: unknown;
      try { data = JSON.parse(message.data); } catch { return; }
      const frame = RunEventEnvelopeSchema.safeParse(data);
      const view = runView(id);
      if (!frame.success || !view || frame.data.event.type !== message.type) return;
      const next = applyRunEventEnvelope(view, frame.data);
      if (next === view) return;
      if (reconnectingRunId.value === id) clearReconnect();
      writeTurn(next);
    };
    for (const name of events) source.addEventListener(name, receive);
    source.onerror = () => {
      if (socket?.source !== source || token !== sessionToken) return;
      closeSocket();
      scheduleReconnect(id, token);
    };
  }

  async function hydrate(detail: SessionDetail) {
    const token = ++historyToken;
    const accept = () => token === historyToken;
    const previous = new Map(turns.value.map((view) => [view.run.id, view]));
    const listed = new Set(detail.runs.map(({ id }) => id));
    turns.value = sortTurns([
      ...detail.runs.map((run) => previous.get(run.id) ?? createRunTurnViewModel(run)),
      ...turns.value.filter(({ run }) => !listed.has(run.id)),
    ]);
    historyError.value = false;
    loadingHistory.value = detail.runs.some(({ id }) => !hydrated.has(id));
    await Promise.all(detail.runs.map(async (run) => {
      const existing = runView(run.id);
      const fresh = hydrated.has(run.id) && existing && run.lastSeq <= existing.lastSeq &&
        (run.status === existing.run.status || !isActiveRunStatus(existing.run.status));
      if (!fresh) {
        try {
          await fetchSnapshot(run.id, accept);
        } catch {
          if (accept()) historyError.value = true;
        }
      }
      if (accept() && reconnectingRunId.value !== run.id) connect(run.id);
    }));
    if (accept()) loadingHistory.value = false;
  }

  function reset(id: SessionId | null) {
    sessionToken++;
    historyToken++;
    currentSession = id;
    closeSocket();
    clearReconnect();
    hydrated.clear();
    turns.value = [];
    loadingHistory.value = false;
    historyError.value = false;
    sending.value = false;
    stoppingRunId.value = null;
    retryEditTarget.value = null;
    issue.value = null;
  }

  watch([sessionId, sessionDetail], ([id, detail]) => {
    if (id !== currentSession) reset(id);
    if (detail !== null && detail.session.id === id) void hydrate(detail);
  }, { immediate: true, flush: 'sync' });

  watch(() => activeRun.value?.id, (id) => {
    clearInterval(clock);
    clock = undefined;
    if (id !== undefined) {
      now.value = Date.now();
      clock = setInterval(() => { now.value = Date.now(); }, 250);
    }
  }, { immediate: true, flush: 'sync' });

  onScopeDispose(() => {
    disposed = true;
    reset(null);
    clearInterval(clock);
  });

  async function launch(request: (id: SessionId) => Promise<InvestigationRun>) {
    const id = currentSession;
    if (id === null || sending.value || activeRun.value) return false;
    const token = sessionToken;
    sending.value = true;
    issue.value = null;
    try {
      const run = await request(id);
      if (run.sessionId !== id) throw new Error('Run session mismatch.');
      if (token !== sessionToken) {
        if (!disposed) syncSessionRunState?.(id, { hasActiveRun: isActiveRunStatus(run.status) });
        if (id === currentSession) await refreshSession?.(id);
        return false;
      }
      const existing = runView(run.id);
      if (!existing || (existing.lastSeq === 0 && isActiveRunStatus(existing.run.status))) {
        writeTurn(createRunTurnViewModel(run));
      }
      hydrated.add(run.id);
      retryEditTarget.value = null;
      publish();
      connect(run.id);
      return true;
    } catch (error) {
      if (token !== sessionToken) return false;
      issue.value = errorIssue(error, '无法启动排查，请重试。');
      if (issue.value.code === 'SESSION_HAS_ACTIVE_RUN') await refreshSession?.(id);
      return false;
    } finally {
      if (token === sessionToken) sending.value = false;
    }
  }

  function submitPrompt(input: string) {
    const prompt = input.trim();
    const edit = retryEditTarget.value;
    if (prompt === '') return Promise.resolve(false);
    return launch((id) => edit ? client.retryRun(edit.runId, { prompt }) : client.startRun(id, { prompt }));
  }

  function retryRunDirect(id: RunId) {
    return launch(() => client.retryRun(id, {}));
  }

  function startEditRetry(run: InvestigationRun) {
    if (run.sessionId !== currentSession || activeRun.value || sending.value || (run.status !== 'stopped' && run.status !== 'failed')) return;
    issue.value = null;
    retryEditTarget.value = { runId: run.id, prompt: run.prompt };
  }

  function cancelEditRetry() { retryEditTarget.value = null; }

  async function stopActiveRun(id: RunId) {
    if (activeRun.value?.id !== id || stoppingRunId.value === id) return;
    const token = sessionToken;
    stoppingRunId.value = id;
    issue.value = null;
    try {
      const result = await client.stopRun(id);
      if (token !== sessionToken || !('alreadyTerminal' in result)) return;
      await fetchSnapshot(id, () => token === sessionToken);
      if (token === sessionToken && stoppingRunId.value === id) stoppingRunId.value = null;
    } catch (error) {
      if (token !== sessionToken) return;
      issue.value = errorIssue(error, '无法确认排查是否停止，请重试。');
      stoppingRunId.value = null;
    }
  }

  return {
    turns, activeRun, loadingHistory, historyError, sending, stoppingRunId, retryEditTarget, issue,
    reconnectingRunId, reconnectAttempts, reconnectExhausted, maxReconnectAttempts, elapsedMs,
    submitPrompt, retryRunDirect, startEditRetry, cancelEditRetry, stopActiveRun,
  };
}
