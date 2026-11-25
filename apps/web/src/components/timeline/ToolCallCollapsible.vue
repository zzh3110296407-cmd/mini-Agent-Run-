<script setup lang="ts">
import type { SessionId } from '@mini-agent-run/shared';
import { computed, useId } from 'vue';
import type { InspectorTargetRequest } from '../../composables/useRunStream';
import { formatBytes, formatDurationMs } from '../../utils/formatters';
import { toolInspectorTarget } from '../../utils/inspectorTargets';
import type { ToolCallViewItem } from '../../utils/runTimelineReducer';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ tool: ToolCallViewItem; sessionId: SessionId; expanded: boolean }>();
const emit = defineEmits<{ toggle: []; inspect: [target: InspectorTargetRequest] }>();
const contentId = useId();
const icons = { running: 'loader', done: 'check-circle', error: 'alert-circle' } as const;
const labels = { running: '执行中', done: '完成', error: '失败' } as const;
const target = computed(() => toolInspectorTarget(props.sessionId, {
  ...props.tool, line: props.tool.summary?.firstErrorLine ?? undefined,
}, props.tool.toolName));
</script>

<template>
  <section class="tool-card" data-testid="tool-call-card" :data-tool-id="tool.toolCallId" :data-tool-key="tool.key" :data-tool-status="tool.status">
    <button
      type="button" class="tool-toggle" data-testid="tool-toggle-btn" :aria-expanded="expanded"
      :aria-controls="contentId" @click="emit('toggle')"
    >
      <UiIcon :name="expanded ? 'chevron-down' : 'chevron-right'" :size="13" />
      <UiIcon :name="icons[tool.status]" :size="14" class="tool-status-icon" />
      <code>{{ tool.toolName }}</code>
      <span class="sr-only">{{ labels[tool.status] }}</span>
      <span v-if="tool.progressMessage || tool.status === 'error'" class="tool-preview">{{ tool.progressMessage || tool.preview }}</span>
      <span class="tool-time tabular-nums">{{ formatDurationMs(tool.durationMs ?? tool.elapsedMs) }}</span>
    </button>
    <div v-if="expanded" :id="contentId" class="tool-body">
      <div class="tool-field"><span>入参</span><pre>{{ JSON.stringify(tool.arguments, null, 2) }}</pre></div>
      <div v-if="tool.preview" class="tool-field"><span>输出预览</span><pre>{{ tool.preview }}</pre></div>
      <div v-if="tool.summary" class="tool-summary tabular-nums">
        <span>{{ formatBytes(tool.summary.byteSize) }}</span><span>{{ tool.summary.lineCount }} 行</span>
        <span>ERROR {{ tool.summary.levelCounts.error }}</span><span>WARN {{ tool.summary.levelCounts.warn }}</span>
        <span>INFO {{ tool.summary.levelCounts.info }}</span><span>其他 {{ tool.summary.levelCounts.other }}</span>
      </div>
      <UiButton v-if="target" variant="subtle" size="sm" data-testid="tool-inspect-btn" @click="emit('inspect', target)">
        <UiIcon name="panel-right" :size="14" />查看{{ target.mode === 'artifact' ? '产物' : '原文件' }}
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.tool-card { min-width: 0; overflow: hidden; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); }
.tool-card[data-tool-status="running"] .tool-status-icon { color: var(--status-running-fg); }
.tool-card[data-tool-status="error"] .tool-status-icon { color: var(--status-failed-fg); }
.tool-card[data-tool-status="done"] .tool-status-icon { color: var(--status-completed-fg); }
.tool-toggle { display: flex; align-items: center; text-align: left; gap: 7px; width: 100%; min-width: 0; padding: 6px 8px; border: 0; background: transparent; }
.tool-toggle:hover { background: var(--bg-hover); }
.tool-toggle:focus-visible { outline-offset: -2px; }
code, pre { font: 12px/18px var(--font-mono); }
.tool-toggle code, .tool-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-preview, .tool-time { color: var(--text-secondary); font-size: 11px; }
.tool-time { flex: none; margin-inline-start: auto; }
.tool-body { display: grid; justify-items: start; gap: 7px; padding: 8px; border-top: 1px solid var(--border-subtle); }
.tool-field { width: 100%; min-width: 0; color: var(--text-secondary); font-size: 12px; }
pre { margin: 3px 0 0; padding: 7px; max-width: 100%; overflow: auto; color: var(--text-code); background: var(--bg-muted); border-radius: var(--radius-xs); }
.tool-summary { display: flex; flex-wrap: wrap; gap: 8px; color: var(--text-secondary); font-size: 11px; }
</style>
