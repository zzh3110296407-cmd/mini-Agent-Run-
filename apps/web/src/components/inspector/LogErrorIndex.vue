<script setup lang="ts">
import type { LogLine } from '@mini-agent-run/shared';
import UiButton from '../ui/UiButton.vue';

defineProps<{
  rows: readonly LogLine[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  error: string;
  selectedLine: number | null;
}>();
const emit = defineEmits<{ jump: [line: number]; more: []; retry: [] }>();
</script>

<template>
  <section class="error-index" data-testid="log-error-index" aria-label="错误行索引">
    <h3>错误行 <span class="tabular-nums" data-testid="log-error-count">{{ total }}</span></h3>
    <div class="error-list">
      <button
        v-for="row in rows" :key="row.lineNumber" type="button" data-testid="log-error-jump"
        :aria-current="selectedLine === row.lineNumber ? 'location' : undefined" :data-error-line="row.lineNumber"
        :title="row.text" @click="emit('jump', row.lineNumber)"
      >
        <code class="tabular-nums">L{{ row.lineNumber }}</code>
        <span class="error-preview" data-testid="log-error-preview">{{ row.text }}</span>
      </button>
      <p v-if="loading" role="status">正在读取错误行…</p>
      <template v-else-if="error">
        <p role="alert">{{ error }}</p>
        <UiButton variant="ghost" size="sm" @click="emit('retry')">重试</UiButton>
      </template>
      <p v-else-if="!rows.length">当前来源无错误行</p>
      <UiButton v-if="hasMore" variant="ghost" size="sm" data-testid="log-load-more-errors" :disabled="loading" @click="emit('more')">
        加载更多错误
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.error-index { display: flex; min-height: 0; min-width: 0; flex-direction: column; border-inline-start: 1px solid var(--border-subtle); background: var(--bg-panel); }
h3 { flex: none; display: flex; justify-content: space-between; gap: 3px; margin: 0; padding: 6px; border-bottom: 1px solid var(--border-subtle); font-size: 12px; }
h3 span { color: var(--status-failed-fg); }
.error-list { flex: 1; min-height: 0; overflow: auto; }
.error-list > button[data-error-line] { display: grid; width: 100%; padding: 5px 6px; gap: 1px; border: 0; border-bottom: 1px solid var(--border-subtle); background: transparent; color: var(--text-secondary); text-align: start; cursor: pointer; }
.error-list > button[data-error-line]:hover, .error-list > button[aria-current="location"] { background: var(--accent-soft-bg); }
.error-list code { color: var(--status-failed-fg); }
.error-preview { overflow: hidden; font: 11px/16px var(--font-mono); text-overflow: ellipsis; white-space: pre; }
p { margin: 5px; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
</style>
