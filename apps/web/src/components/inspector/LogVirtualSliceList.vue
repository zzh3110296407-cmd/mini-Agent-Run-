<script setup lang="ts">
import type { LogLine } from '@mini-agent-run/shared';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { LineRange } from '../../composables/useLogInspector';
import { splitHighlightSegments } from '../../utils/highlightSegments';

const props = defineProps<{
  lines: readonly LogLine[];
  searchQuery: string;
  focusRange: LineRange | null;
  selectedLine: number | null;
  scrollRequest: number;
}>();
const ROW_HEIGHT = 24;
const overscan = 20;
const viewport = ref<HTMLElement | null>(null);
const top = ref(0);
const height = ref(480);
const virtual = computed(() => props.lines.length > 200);
const start = computed(() => virtual.value ? Math.max(0, Math.floor(top.value / ROW_HEIGHT) - overscan) : 0);
const end = computed(() => virtual.value
  ? Math.min(props.lines.length, Math.floor(top.value / ROW_HEIGHT) + Math.ceil(height.value / ROW_HEIGHT) + 1 + overscan)
  : props.lines.length);
const visible = computed(() => props.lines.slice(start.value, end.value).map((row) => ({
  ...row, segments: splitHighlightSegments(row.text, props.searchQuery),
})));
const totalHeight = computed(() => props.lines.length * ROW_HEIGHT);
const before = computed(() => start.value * ROW_HEIGHT);
const after = computed(() => (props.lines.length - end.value) * ROW_HEIGHT);
let resize: ResizeObserver | undefined;

function measure() {
  const element = viewport.value;
  if (!element) return;
  height.value = Math.min(element.clientHeight || 480, ROW_HEIGHT * 48);
  top.value = element.scrollTop;
}

function seek() {
  const element = viewport.value;
  if (!element) return;
  if (props.selectedLine === null) {
    element.scrollTop = 0;
  } else {
    const index = props.lines.findIndex(({ lineNumber }) => lineNumber === props.selectedLine);
    if (index === -1) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < element.scrollTop || rowBottom > element.scrollTop + height.value) {
      element.scrollTop = Math.max(0, rowTop - Math.floor((height.value - ROW_HEIGHT) / 2));
    }
  }
  measure();
}

function highlighted(line: number) {
  const range = props.focusRange;
  return props.selectedLine === line || (range !== null && line >= range.startLine && line <= range.endLine);
}

onMounted(() => {
  measure();
  seek();
  if (typeof ResizeObserver === 'function' && viewport.value) {
    resize = new ResizeObserver(measure);
    resize.observe(viewport.value);
  }
});
onBeforeUnmount(() => resize?.disconnect());
watch(() => props.scrollRequest, seek, { flush: 'post' });
</script>

<template>
  <div
    ref="viewport" class="log-viewport" data-testid="log-scroll-container" aria-label="日志正文"
    tabindex="0" @scroll.passive="measure"
  >
    <div v-if="before" aria-hidden="true" :style="{ height: before + 'px' }" />
    <div v-if="lines.length" :data-content-height="totalHeight">
      <div
        v-for="row in visible" :key="row.lineNumber" class="log-row" data-testid="log-line"
        :data-line-number="row.lineNumber" :data-level="row.level"
        :data-highlighted="String(highlighted(row.lineNumber))" :data-selected="String(selectedLine === row.lineNumber)"
      >
        <span class="line-number tabular-nums">{{ row.lineNumber }}</span>
        <code class="line-text" data-testid="log-line-text"><template v-for="(segment, index) in row.segments" :key="index"><mark v-if="segment.matched">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></code>
      </div>
    </div>
    <div v-if="after" aria-hidden="true" :style="{ height: after + 'px' }" />
  </div>
</template>

<style scoped>
.log-viewport { flex: 1; min-width: 0; min-height: 0; max-height: calc(var(--log-row-height) * 48); overflow: auto; overflow-anchor: none; scrollbar-gutter: stable; }
.log-row { display: flex; align-items: center; box-sizing: border-box; height: var(--log-row-height, 24px); padding-inline: 4px 8px; border-inline-start: 3px solid transparent; font: 12px/var(--log-row-height, 24px) var(--font-mono); }
.log-row[data-level="error"] { background: var(--log-row-error-bg); }
.log-row[data-level="warn"] { background: var(--log-row-warn-bg); }
.log-row[data-highlighted="true"] { border-inline-start-color: var(--log-evidence-bar); background: var(--log-evidence-bg); }
.log-row[data-selected="true"] { box-shadow: inset 0 0 0 1px var(--accent-soft-border); }
.line-number { flex: none; width: 5ch; padding-inline-end: 1ch; color: var(--text-tertiary, var(--text-secondary)); text-align: end; user-select: none; }
.log-row[data-level="error"] .line-number { color: var(--status-failed-fg); }
.log-row[data-level="warn"] .line-number { color: var(--status-warn-fg); }
.line-text { flex: none; color: var(--text-code); font: inherit; white-space: pre; }
mark { border-radius: 2px; background: var(--status-warn-bg); color: var(--status-warn-fg); }
</style>
