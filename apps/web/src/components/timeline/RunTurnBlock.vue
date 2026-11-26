<script setup lang="ts">
import type { EvidenceRef, InvestigationRun, RunId } from '@mini-agent-run/shared';
import { computed, ref, useId } from 'vue';
import type { InspectorTargetRequest } from '../../composables/useRunStream';
import { formatDurationMs, formatRunStatus, formatStopReason } from '../../utils/formatters';
import { evidenceInspectorTarget } from '../../utils/inspectorTargets';
import { isActiveRunStatus, type RunTurnViewModel } from '../../utils/runTimelineReducer';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import ConclusionCard from './ConclusionCard.vue';
import SafeMarkdownView from './SafeMarkdownView.vue';
import ToolCallCollapsible from './ToolCallCollapsible.vue';

const props = defineProps<{
  turn: RunTurnViewModel;
  elapsedMs: number;
  controlsLocked: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectExhausted: boolean;
  highlighted: boolean;
}>();
const emit = defineEmits<{
  retry: [id: RunId];
  editRetry: [run: InvestigationRun];
  jumpRun: [id: RunId];
  openInspector: [target: InspectorTargetRequest];
}>();
const run = computed(() => props.turn.run);
const isActive = computed(() => isActiveRunStatus(run.value.status));
const canRetry = computed(() => run.value.status === 'stopped' || run.value.status === 'failed');
const detailsOpen = ref(false);
const expanded = ref(new Set<number>());
const detailsId = useId();
const statusTones = { pending: 'neutral', running: 'running', completed: 'completed', stopped: 'stopped', failed: 'failed' } as const;
const statusIcons = { pending: 'clock', running: 'loader', completed: 'check-circle', stopped: 'square', failed: 'x-circle' } as const;

function toggle(key: number) {
  if (expanded.value.has(key)) expanded.value.delete(key);
  else expanded.value.add(key);
}

function openEvidence(evidence: EvidenceRef) {
  emit('openInspector', evidenceInspectorTarget(run.value.sessionId, evidence));
}

</script>

<template>
  <article
    class="run-turn" :class="{ highlighted }" data-testid="run-turn-block" :data-run-id="run.id"
    :data-run-status="run.status" tabindex="-1"
  >
    <p class="prompt">{{ run.prompt }}</p>
    <div class="run-output">
      <div class="run-header">
        <UiBadge :tone="statusTones[run.status]" :data-run-badge="run.status">
          <UiIcon :name="statusIcons[run.status]" :size="13" />{{ formatRunStatus(run.status) }}
        </UiBadge>
        <span class="tabular-nums">{{ turn.currentStep }}{{ run.maxSteps === null ? '' : ' / ' + run.maxSteps }} 步</span>
        <span v-if="isActive || run.durationMs !== null" class="tabular-nums">
          {{ formatDurationMs(isActive ? elapsedMs : run.durationMs ?? 0) }}
        </span>
        <UiButton
          v-if="run.retryOfRunId !== null" variant="ghost" size="sm" data-testid="retry-origin-link"
          @click="emit('jumpRun', run.retryOfRunId)"
        >原排查 <code>#{{ run.retryOfRunId }}</code></UiButton>
      </div>
      <SafeMarkdownView v-if="turn.streamText !== ''" :content="turn.streamText" />
      <p v-else-if="isActive && !turn.activeTool" class="muted">等待模型输出…</p>
      <div v-if="isActive && turn.activeTool" class="active-tool" data-testid="active-tool-status" role="status">
        <span class="activity-dot" aria-hidden="true" />
        <span>正在执行 <code>{{ turn.activeTool.toolName }}</code></span>
        <span v-if="turn.activeTool.progressMessage" class="progress" :title="turn.activeTool.progressMessage">{{ turn.activeTool.progressMessage }}</span>
        <span class="tool-elapsed tabular-nums">{{ formatDurationMs(turn.activeTool.elapsedMs) }}</span>
      </div>
      <ConclusionCard v-if="turn.conclusion" :conclusion="turn.conclusion" @open-evidence="openEvidence" />
      <div v-if="turn.toolCalls.length" class="run-details">
        <UiButton
          variant="ghost" size="sm" data-testid="run-details-toggle" :aria-expanded="detailsOpen" :aria-controls="detailsId"
          @click="detailsOpen = !detailsOpen"
        >
          <UiIcon :name="detailsOpen ? 'chevron-down' : 'chevron-right'" :size="14" />
          <span class="tabular-nums">运行详情 · {{ turn.currentStep }} 步 · {{ turn.toolCalls.length }} 次工具调用</span>
        </UiButton>
        <div v-if="detailsOpen" :id="detailsId" class="tools">
          <ToolCallCollapsible
            v-for="tool in turn.toolCalls" :key="tool.key"
            :tool="tool" :session-id="run.sessionId" :expanded="expanded.has(tool.key)"
            @toggle="toggle(tool.key)" @inspect="emit('openInspector', $event)"
          />
        </div>
      </div>
      <div v-if="reconnecting" class="connection-banner" role="status" data-testid="sse-reconnecting-banner">
        <UiIcon name="refresh-cw" :size="14" />
        <span>{{ reconnectExhausted ? '实时连接已中断，重连次数已用尽。' : '连接已断开，正在重连…' }}</span>
        <span class="tabular-nums">{{ reconnectAttempts }} / {{ maxReconnectAttempts }}</span>
      </div>
      <div v-if="canRetry" class="terminal-actions" :class="run.status">
        <span v-if="run.status === 'failed' && turn.error"><code>{{ turn.error.code }}</code> {{ turn.error.message }}</span>
        <span v-else>{{ formatStopReason(run.stopReason) }}</span>
        <div class="retry-buttons">
          <UiButton variant="default" size="sm" data-testid="retry-run-btn" :disabled="controlsLocked" @click="emit('retry', run.id)">
            <UiIcon name="rotate-ccw" :size="13" />重新执行
          </UiButton>
          <UiButton
            variant="ghost" size="sm" data-testid="edit-retry-run-btn" :disabled="controlsLocked"
            @click="emit('editRetry', run)"
          ><UiIcon name="pencil" :size="13" />修改问题后重跑</UiButton>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.run-turn { min-width: 0; display: grid; gap: 10px; padding: 4px; border: 1px solid transparent; border-radius: var(--radius-md); }
.run-turn.highlighted { border-color: var(--accent-soft-border); background: var(--accent-soft-bg); }
.prompt { justify-self: end; width: fit-content; max-width: min(92%, 620px); margin: 0; padding: 8px 11px; border-radius: var(--radius-lg) var(--radius-lg) var(--radius-xs) var(--radius-lg); background: var(--bg-active); border: 1px solid var(--accent-soft-border); white-space: pre-wrap; overflow-wrap: anywhere; }
.run-output { display: grid; gap: 8px; min-width: 0; padding: 11px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-panel); }
.run-header, .active-tool, .connection-banner { display: flex; min-width: 0; align-items: center; flex-wrap: wrap; gap: 7px; color: var(--text-secondary); font-size: 12px; }
.run-header code, .terminal-actions code, .active-tool code { font-family: var(--font-mono); overflow-wrap: anywhere; }
.run-header :deep(button) { max-width: 100%; white-space: normal; }
.run-header :deep(button code) { min-width: 0; }
.muted { margin: 0; color: var(--text-secondary); }
.active-tool { flex-wrap: nowrap; padding: 5px 7px; border: 1px solid var(--status-running-border); border-radius: var(--radius-sm); background: var(--status-running-bg); }
.activity-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--status-running-dot); animation: pulse 1.6s ease-in-out infinite; }
.progress { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-elapsed { margin-inline-start: auto; }
.tools { display: grid; gap: 5px; margin-top: 4px; }
.connection-banner { padding: 5px 7px; background: var(--status-warn-bg); color: var(--status-warn-fg); border-radius: var(--radius-sm); }
.terminal-actions { display: grid; gap: 5px; color: var(--status-stopped-fg); font-size: 12px; overflow-wrap: anywhere; }
.terminal-actions.failed { color: var(--status-failed-fg); }
.retry-buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
@keyframes pulse { 50% { opacity: .45; } }
</style>
