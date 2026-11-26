<script setup lang="ts">
import type { CreateSessionRequest, SessionId, SessionListItem } from '@mini-agent-run/shared';
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import LargeLogInspector from './components/inspector/LargeLogInspector.vue';
import AppTopbar from './components/layout/AppTopbar.vue';
import ResizableDivider from './components/layout/ResizableDivider.vue';
import DeleteSessionAlert from './components/sidebar/DeleteSessionAlert.vue';
import PathPickerModal from './components/sidebar/PathPickerModal.vue';
import SessionSidebar from './components/sidebar/SessionSidebar.vue';
import SettingsModal from './components/sidebar/SettingsModal.vue';
import InvestigationWorkspace from './components/timeline/InvestigationWorkspace.vue';
import UiEmpty from './components/ui/UiEmpty.vue';
import UiIcon from './components/ui/UiIcon.vue';
import UiSheet from './components/ui/UiSheet.vue';
import { useApiKeySettings } from './composables/useApiKeySettings';
import { useHealthProbe } from './composables/useHealthProbe';
import { useLogInspector } from './composables/useLogInspector';
import { formatPathError, type PathError } from './composables/usePathBrowser';
import { useRunStream, type InspectorTargetRequest } from './composables/useRunStream';
import { formatSessionError, useSessions } from './composables/useSessions';
import { useWorkbenchLayout } from './composables/useWorkbenchLayout';
import { isTextEntry } from './utils/isTextEntry';

const settingsOpen = ref(false);
const pathOpen = ref(false);
const creating = ref(false);
const creationError = shallowRef<PathError | null>(null);
const deletionTarget = shallowRef<SessionListItem | null>(null);
const deleting = ref(false);
const deletionError = ref('');
const { hasCustomApiKey } = useApiKeySettings();
const { health, checkHealth } = useHealthProbe();
const { viewport, theme, inspectorOpen, sidebarDrawerOpen, inspectorWidth, toggleTheme, setInspectorWidth } = useWorkbenchLayout();
const {
  sessions, filteredSessions, filterQuery, activeSessionId, activeSessionDetail, loading, detailLoading, errorMessage,
  createSession, renameSession, deleteSession, selectSession, loadSessions, refreshSessions, syncSessionRunState,
} = useSessions();

const stream = useRunStream({
  sessionId: activeSessionId,
  sessionDetail: activeSessionDetail,
  async refreshSession(id) {
    if (id === activeSessionId.value) await Promise.all([selectSession(id), refreshSessions()]);
  },
  syncSessionRunState(id, patch) {
    syncSessionRunState(id, patch);
    void refreshSessions();
  },
});

const summary = computed(() => {
  const listed = sessions.value.find(({ id }) => id === activeSessionId.value);
  const detail = activeSessionDetail.value;
  const session = detail?.session ?? listed;
  if (!session) return null;
  return {
    session, runCount: listed?.runCount ?? detail?.runs.length ?? 0,
    hasActiveRun: listed?.hasActiveRun ?? detail?.hasActiveRun ?? false,
  };
});
const inspectorSession = computed(() => summary.value?.session ?? null);
const logInspector = useLogInspector({ session: inspectorSession, open: inspectorOpen });

function openPicker() {
  creationError.value = null;
  pathOpen.value = true;
}

function closePicker() {
  if (!creating.value) pathOpen.value = false;
}

async function confirmCreate(input: CreateSessionRequest) {
  if (creating.value) return;
  creating.value = true;
  try {
    await createSession(input);
    pathOpen.value = false;
  } catch (error) {
    creationError.value = formatPathError(error);
  } finally {
    creating.value = false;
  }
}

function openDelete(session: SessionListItem) {
  deletionError.value = '';
  deletionTarget.value = session;
}

function closeDelete() {
  if (!deleting.value) deletionTarget.value = null;
}

async function confirmDelete() {
  const target = deletionTarget.value;
  if (!target || deleting.value) return;
  deleting.value = true;
  deletionError.value = '';
  try {
    await deleteSession(target.id);
    deletionTarget.value = null;
  } catch (error) {
    deletionError.value = formatSessionError(error, '无法删除会话，请重试。');
  } finally {
    deleting.value = false;
  }
}

function chooseSession(id: SessionId) {
  sidebarDrawerOpen.value = false;
  void selectSession(id);
}

const sidebarProps = computed(() => ({
  sessions: filteredSessions.value, activeSessionId: activeSessionId.value, filterQuery: filterQuery.value,
  loading: loading.value, errorMessage: errorMessage.value, hasCustomApiKey: hasCustomApiKey.value,
}));
const sidebarEvents = {
  create: openPicker, select: chooseSession, rename: renameSession, requestDelete: openDelete,
  settings: () => { settingsOpen.value = true; }, retry: loadSessions,
  'update:filterQuery': (query: string) => { filterQuery.value = query; },
};

function toggleSidebarDrawer() {
  sidebarDrawerOpen.value = !sidebarDrawerOpen.value;
  if (sidebarDrawerOpen.value && viewport.value === 'mobile') inspectorOpen.value = false;
}

function toggleInspector() {
  inspectorOpen.value = !inspectorOpen.value;
  if (inspectorOpen.value && viewport.value !== 'desktop') sidebarDrawerOpen.value = false;
}

function openInspector(target: InspectorTargetRequest) {
  logInspector.openTarget(target);
  inspectorOpen.value = true;
  if (viewport.value !== 'desktop') sidebarDrawerOpen.value = false;
}

function closeFilePickerOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !logInspector.filePickerOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  logInspector.filePickerOpen.value = false;
}

async function handleKeyboard(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === 'Escape') {
    if (deletionTarget.value) closeDelete();
    else if (pathOpen.value) closePicker();
    else if (settingsOpen.value) settingsOpen.value = false;
    else if (sidebarDrawerOpen.value) sidebarDrawerOpen.value = false;
    else if (viewport.value !== 'desktop') inspectorOpen.value = false;
    return;
  }
  if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)
    || isTextEntry(document.activeElement) || pathOpen.value || deletionTarget.value || settingsOpen.value) return;
  event.preventDefault();
  if (viewport.value === 'mobile') {
    inspectorOpen.value = false;
    sidebarDrawerOpen.value = true;
    await nextTick();
  } else if (viewport.value === 'tablet' && inspectorOpen.value) {
    inspectorOpen.value = false;
    await nextTick();
  }
  document.querySelector<HTMLInputElement>('[data-testid="session-filter-input"]')?.focus();
}

onMounted(() => {
  window.addEventListener('keydown', closeFilePickerOnEscape, true);
  window.addEventListener('keydown', handleKeyboard);
});
onUnmounted(() => {
  window.removeEventListener('keydown', closeFilePickerOnEscape, true);
  window.removeEventListener('keydown', handleKeyboard);
});
</script>

<template>
  <div class="workbench" :data-layout="viewport">
    <AppTopbar
      :theme="theme" :health="health" :show-sidebar-toggle="viewport === 'mobile'" :sidebar-open="sidebarDrawerOpen"
      :inspector-open="inspectorOpen"
      @retry-health="checkHealth" @toggle-theme="toggleTheme" @toggle-sidebar="toggleSidebarDrawer" @toggle-inspector="toggleInspector"
    />
    <div class="workbench-body">
      <aside v-if="viewport !== 'mobile'" id="sidebar-pane" class="workbench-sidebar" aria-label="排查会话">
        <SessionSidebar v-bind="sidebarProps" v-on="sidebarEvents" />
      </aside>
      <main class="workspace">
        <InvestigationWorkspace
          v-if="summary" :key="summary.session.id" :session="summary.session" :stream="stream"
          :ready="activeSessionDetail?.session.id === summary.session.id" :detail-loading="detailLoading"
          @open-inspector="openInspector" @open-settings="settingsOpen = true"
        />
        <div v-else class="workspace-inner">
          <h1>排查工作区</h1>
          <UiEmpty :title="loading || detailLoading ? '正在读取会话…' : '尚未选择会话'">
            <template #icon><UiIcon name="folder-open" :size="23" /></template>
            <template v-if="!loading && !detailLoading">点击「新建排查会话」，选择要排查的轨迹文件或目录。</template>
          </UiEmpty>
        </div>
      </main>
      <template v-if="viewport === 'desktop' && inspectorOpen">
        <ResizableDivider :width="inspectorWidth" @update:width="setInspectorWidth" />
        <aside id="inspector-panel" class="inspector" :style="{ width: inspectorWidth + 'px' }" aria-label="日志检视器">
          <h2>日志检视器</h2>
          <LargeLogInspector v-if="inspectorSession" :key="inspectorSession.id" :session="inspectorSession" :inspector="logInspector" />
          <UiEmpty v-else class="inspector-empty" title="选择会话后可查看绑定目标" />
        </aside>
      </template>
    </div>
    <UiSheet
      v-if="viewport === 'mobile'" id="sidebar-pane" :open="sidebarDrawerOpen" side="left" title="排查会话"
      @close="sidebarDrawerOpen = false"
    >
      <SessionSidebar :show-heading="false" v-bind="sidebarProps" v-on="sidebarEvents" />
    </UiSheet>
    <UiSheet
      v-if="viewport !== 'desktop'" id="inspector-panel" :open="inspectorOpen" side="right" title="日志检视器"
      @close="inspectorOpen = false"
    >
      <div class="inspector-sheet-body">
        <LargeLogInspector v-if="inspectorSession" :key="inspectorSession.id" :session="inspectorSession" :inspector="logInspector" />
        <UiEmpty v-else class="inspector-empty" title="选择会话后可查看绑定目标" />
      </div>
    </UiSheet>
    <PathPickerModal
      :open="pathOpen" :creating="creating" :creation-error="creationError"
      @close="closePicker" @confirm="confirmCreate" @clear-error="creationError = null"
    />
    <DeleteSessionAlert :session="deletionTarget" :deleting="deleting" :error="deletionError" @close="closeDelete" @confirm="confirmDelete" />
    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<style scoped>
.workbench { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.workbench-body { display: flex; flex: 1; min-height: 0; }
.workbench-sidebar, .inspector { flex: none; min-height: 0; background: var(--bg-panel); }
.workbench-sidebar { width: var(--sidebar-width); border-inline-end: 1px solid var(--border-subtle); }
.workspace { display: flex; flex: 1; flex-direction: column; min-width: 0; overflow: hidden; }
.workspace-inner { width: min(100%, 760px); margin-inline: auto; padding: 27px clamp(16px, 4vw, 32px); overflow: auto; }
.workspace h1 { margin: 0 0 15px; font-size: 23px; line-height: 1.28; letter-spacing: -.025em; overflow-wrap: anywhere; }
.inspector > h2 { flex: none; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
.inspector { display: flex; max-width: calc(100% - var(--sidebar-width) - 285px); flex-direction: column; overflow: hidden; }
.inspector-sheet-body { display: flex; min-height: 0; height: 100%; }
.inspector-empty { margin: 12px; }
@media (max-width: 600px) {
  .workspace-inner { padding-top: 20px; }
  .workspace h1 { font-size: 19px; }
}
</style>
