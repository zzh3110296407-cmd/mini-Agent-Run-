<script setup lang="ts">
import type { InvestigationRun, RunId, Session } from '@mini-agent-run/shared';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { InspectorTargetRequest, useRunStream } from '../../composables/useRunStream';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import EmptySessionGuide from './EmptySessionGuide.vue';
import RunTurnBlock from './RunTurnBlock.vue';
import StickyComposer from './StickyComposer.vue';

const props = defineProps<{ session: Session; stream: ReturnType<typeof useRunStream>; ready: boolean; detailLoading: boolean }>();
const emit = defineEmits<{ openInspector: [target: InspectorTargetRequest]; openSettings: [] }>();
const {
  turns, activeRun, sending, loadingHistory, historyError, issue, stoppingRunId, retryEditTarget,
  elapsedMs, reconnectingRunId, reconnectAttempts, maxReconnectAttempts, reconnectExhausted,
  submitPrompt, retryRunDirect, startEditRetry, cancelEditRetry, stopActiveRun,
} = props.stream;
const draft = ref('');
const composer = ref<InstanceType<typeof StickyComposer> | null>(null);
const timeline = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const highlightedRun = ref<RunId | null>(null);
const activeControl = computed(() => activeRun.value && { id: activeRun.value.id, elapsedMs: elapsedMs.value });
const controlsLocked = computed(() => !props.ready || sending.value || activeRun.value !== null);
let draftBeforeRetry = '';

function followLatest() {
  const element = timeline.value;
  if (element && stickToBottom.value) element.scrollTop = element.scrollHeight;
}

function updateScrollLock() {
  const element = timeline.value;
  if (element) stickToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

function returnToLatest() {
  stickToBottom.value = true;
  followLatest();
}

onMounted(followLatest);
watch(turns, followLatest, { flush: 'post' });

async function submit() {
  if (controlsLocked.value || !await submitPrompt(draft.value)) return;
  draft.value = '';
  draftBeforeRetry = '';
  returnToLatest();
}

async function retry(id: RunId) {
  if (controlsLocked.value) return;
  const wasEditing = retryEditTarget.value !== null;
  if (!await retryRunDirect(id)) return;
  if (wasEditing) draft.value = draftBeforeRetry;
  draftBeforeRetry = '';
  returnToLatest();
}

async function editRetry(run: InvestigationRun) {
  if (controlsLocked.value) return;
  const wasEditing = retryEditTarget.value !== null;
  startEditRetry(run);
  if (retryEditTarget.value?.runId !== run.id) return;
  if (!wasEditing) draftBeforeRetry = draft.value;
  draft.value = retryEditTarget.value.prompt;
  await nextTick();
  composer.value?.focus();
}

async function cancelRetry() {
  cancelEditRetry();
  draft.value = draftBeforeRetry;
  draftBeforeRetry = '';
  await nextTick();
  composer.value?.focus();
}

function jumpRun(id: RunId) {
  const anchor = Array.from(timeline.value?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])
    .find((element) => element.dataset.runId === id);
  if (!anchor) return;
  stickToBottom.value = false;
  highlightedRun.value = id;
  anchor.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  anchor.focus({ preventScroll: true });
}
</script>

<template>
  <section class="investigation">
    <header class="session-header">
      <div class="column">
        <h1>{{ session.title }}</h1>
      </div>
    </header>
    <div ref="timeline" class="timeline-scroll" aria-label="排查时间线" data-testid="run-timeline-scroll" @scroll.passive="updateScrollLock">
      <div class="column timeline">
        <p v-if="!ready || loadingHistory" class="history-status" role="status">
          {{ detailLoading || loadingHistory ? '正在读取排查记录…' : '无法读取会话详情，请刷新会话列表。' }}
        </p>
        <p v-else-if="historyError" class="history-status" role="status">部分历史详情暂不可用，仍可查看已有记录。</p>
        <EmptySessionGuide v-if="ready && !loadingHistory && !turns.length" :target-path="session.targetPath" />
        <RunTurnBlock
          v-for="turn in turns" :key="turn.run.id" :turn="turn"
          :controls-locked="controlsLocked" :elapsed-ms="activeRun?.id === turn.run.id ? elapsedMs : 0"
          :reconnecting="reconnectingRunId === turn.run.id" :reconnect-attempts="reconnectAttempts"
          :max-reconnect-attempts="maxReconnectAttempts" :reconnect-exhausted="reconnectExhausted"
          :highlighted="highlightedRun === turn.run.id"
          @retry="retry" @edit-retry="editRetry" @jump-run="jumpRun"
          @open-inspector="emit('openInspector', $event)"
        />
      </div>
    </div>
    <footer class="composer-dock">
      <div class="column composer-column">
        <div v-if="!stickToBottom" class="return-row">
          <UiButton variant="subtle" size="sm" data-testid="scroll-to-bottom-pill" @click="returnToLatest">
            <UiIcon name="chevron-down" :size="14" />回到底部查看最新输出
          </UiButton>
        </div>
        <div v-if="issue" class="issue" role="alert" data-testid="run-issue-banner">
          <UiIcon name="alert-triangle" :size="16" />
          <span>{{ issue.message }}</span>
          <UiButton
            v-if="issue.code === 'LLM_NOT_CONFIGURED'" variant="ghost" size="sm"
            data-testid="open-settings-from-error-btn" @click="emit('openSettings')"
          >打开设置</UiButton>
        </div>
        <StickyComposer
          ref="composer" v-model="draft" :active-run="activeControl" :sending="sending"
          :stopping="stoppingRunId !== null" :retry-context="retryEditTarget" :disabled="!ready"
          @submit="submit" @stop="stopActiveRun" @cancel-retry-edit="cancelRetry"
        />
      </div>
    </footer>
  </section>
</template>

<style scoped>
.investigation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.column { width: min(100%, 850px); margin-inline: auto; padding-inline: clamp(12px, 3vw, 28px); }
.session-header { flex: none; padding-block: 12px; border-bottom: 1px solid var(--border-subtle); }
.session-header h1 { margin: 0; font-size: clamp(17px, 2.4vw, 21px); line-height: 1.3; overflow-wrap: anywhere; }
.timeline-scroll { flex: 1; min-height: 0; overflow: auto; overflow-anchor: none; }
.timeline { display: grid; gap: 12px; padding-block: 14px; }
.history-status { margin: 0; color: var(--text-secondary); font-size: 12px; }
.composer-dock { position: relative; flex: none; padding-block: 8px max(9px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); background: var(--bg-panel); }
.composer-column { display: grid; gap: 7px; }
.return-row { position: absolute; inset: auto 0 calc(100% + 6px); display: flex; justify-content: center; pointer-events: none; }
.return-row :deep(button) { pointer-events: auto; border-radius: 999px; box-shadow: var(--shadow-sm); }
.issue { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--status-warn-border); border-radius: var(--radius-sm); background: var(--status-warn-bg); color: var(--status-warn-fg); font-size: 12px; }
.issue svg, .issue :deep(button) { flex: none; }
.issue :deep(button) { margin-inline-start: auto; }
</style>
