import type { CreateSessionRequest, SessionDetail, SessionId, SessionListItem } from '@mini-agent-run/shared';
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { ApiError, apiClient } from '../api/client';
import { readLocalStorage, writeLocalStorage } from '../utils/localStorage';

const sessionKey = 'mini-agent-run.active-session-id';
type SessionClient = Pick<typeof apiClient, 'createSession' | 'listSessions' | 'getSessionDetail' | 'renameSession' | 'deleteSession'>;

export function formatSessionError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'SESSION_HAS_ACTIVE_RUN') return '当前会话存在运行中的排查任务，请先停止后再删除。';
    if (error.status === 404) return '此会话已不存在，请刷新会话列表。';
    if (error.code === 'NETWORK_ERROR') return error.message;
  }
  return fallback;
}

export function useSessions(client: SessionClient = apiClient) {
  const sessions = shallowRef<SessionListItem[]>([]);
  const filterQuery = ref('');
  const activeSessionId = ref<SessionId | null>(null);
  const activeSessionDetail = shallowRef<SessionDetail | null>(null);
  const loading = ref(false);
  const detailLoading = ref(false);
  const listError = ref('');
  const detailError = ref('');
  const errorMessage = computed(() => listError.value || detailError.value);
  let listRequest = 0;
  let detailRequest = 0;

  const filteredSessions = computed(() => {
    const query = filterQuery.value.trim().toLowerCase();
    return query === '' ? sessions.value : sessions.value.filter((session) =>
      session.title.toLowerCase().includes(query) || session.targetPath.toLowerCase().includes(query));
  });

  async function refreshSessions() {
    const request = ++listRequest;
    loading.value = true;
    listError.value = '';
    try {
      const result = await client.listSessions();
      if (request !== listRequest) return false;
      sessions.value = result.sessions;
      return true;
    } catch (error) {
      if (request === listRequest) listError.value = formatSessionError(error, '无法读取会话列表，请重试。');
      return false;
    } finally {
      if (request === listRequest) loading.value = false;
    }
  }

  async function selectSession(id: SessionId | null) {
    const request = ++detailRequest;
    if (id !== activeSessionId.value) activeSessionDetail.value = null;
    activeSessionId.value = id;
    writeLocalStorage(sessionKey, id);
    detailError.value = '';
    detailLoading.value = id !== null;
    if (id === null) return;
    try {
      const detail = await client.getSessionDetail(id);
      if (request === detailRequest) activeSessionDetail.value = detail;
    } catch (error) {
      if (request === detailRequest) detailError.value = formatSessionError(error, '无法读取当前会话详情，请重试。');
    } finally {
      if (request === detailRequest) detailLoading.value = false;
    }
  }

  async function loadSessions() {
    if (!await refreshSessions()) return;
    const preferred = activeSessionId.value ?? readLocalStorage(sessionKey);
    const selected = sessions.value.find(({ id }) => id === preferred) ?? sessions.value[0];
    await selectSession(selected?.id ?? null);
  }

  async function createSession(input: CreateSessionRequest) {
    const created = await client.createSession(input);
    sessions.value = [{ ...created, runCount: 0, hasActiveRun: false }, ...sessions.value.filter(({ id }) => id !== created.id)];
    await Promise.all([refreshSessions(), selectSession(created.id)]);
    return created;
  }

  async function renameSession(id: SessionId, rawTitle: string) {
    const title = rawTitle.trim();
    if (!title) return;
    try {
      const renamed = await client.renameSession(id, { title });
      sessions.value = sessions.value.map((item) => item.id === id ? { ...item, ...renamed } : item);
      if (activeSessionDetail.value?.session.id === id) {
        activeSessionDetail.value = { ...activeSessionDetail.value, session: renamed };
      }
      await Promise.all([refreshSessions(), ...(activeSessionId.value === id ? [selectSession(id)] : [])]);
    } catch (error) {
      listError.value = formatSessionError(error, '无法重命名会话，请重试。');
    }
  }

  async function deleteSession(id: SessionId) {
    await client.deleteSession(id);
    sessions.value = sessions.value.filter((item) => item.id !== id);
    await refreshSessions();
    if (activeSessionId.value === id) await selectSession(sessions.value[0]?.id ?? null);
  }

  onMounted(loadSessions);
  onUnmounted(() => { listRequest++; detailRequest++; });

  return {
    sessions, filteredSessions, filterQuery, activeSessionId, activeSessionDetail, loading, detailLoading, errorMessage,
    createSession, renameSession, deleteSession, selectSession, loadSessions,
  };
}
