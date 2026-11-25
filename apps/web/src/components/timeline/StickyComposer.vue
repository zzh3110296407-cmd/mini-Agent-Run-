<script setup lang="ts">
import type { RunId } from '@mini-agent-run/shared';
import { computed, ref } from 'vue';
import { formatDurationMs } from '../../utils/formatters';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiKbd from '../ui/UiKbd.vue';

const props = defineProps<{
  modelValue: string;
  activeRun: { id: RunId; elapsedMs: number } | null;
  sending: boolean;
  stopping: boolean;
  retryContext: { runId: RunId } | null;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  stop: [runId: RunId];
  cancelRetryEdit: [];
}>();
const textarea = ref<HTMLTextAreaElement | null>(null);
const locked = computed(() => props.activeRun !== null || props.sending || props.disabled);
const canSend = computed(() => !locked.value && props.modelValue.trim() !== '');

function update(event: Event) {
  if (event.target instanceof HTMLTextAreaElement) emit('update:modelValue', event.target.value);
}
function send() { if (canSend.value) emit('submit'); }
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send();
}
defineExpose({ focus: () => textarea.value?.focus() });
</script>

<template>
  <form class="uiv-composer" :class="{ 'uiv-composer--running': activeRun }" @submit.prevent="send">
    <div v-if="retryContext" class="retry-context">
      <span>正在基于 <code>#{{ retryContext.runId }}</code> 修改问题重跑</span>
      <UiButton size="sm" variant="ghost" data-testid="cancel-retry-edit-btn" aria-label="取消关联重跑" @click="emit('cancelRetryEdit')">
        <UiIcon name="x" :size="14" />取消关联
      </UiButton>
    </div>
    <textarea
      ref="textarea" data-testid="prompt-input" rows="2" :value="modelValue" :disabled="locked" aria-label="描述排查问题"
      :placeholder="activeRun ? '当前会话正在排查，可随时停止…' : '描述你想排查的问题…'"
      @input="update" @keydown="keydown"
    />
    <div class="composer-controls">
      <div class="composer-hint" aria-hidden="true"><UiKbd>Enter</UiKbd> 发送 <UiKbd>Shift+Enter</UiKbd> 换行</div>
      <UiButton
        v-if="activeRun" variant="destructive" data-testid="stop-run-btn" :disabled="stopping"
        @click="emit('stop', activeRun.id)"
      >
        <UiIcon name="square" :size="14" />{{ stopping ? '正在停止…' : '停止排查' }}
        <span class="tabular-nums">{{ formatDurationMs(activeRun.elapsedMs) }}</span>
      </UiButton>
      <UiButton v-else type="submit" variant="primary" data-testid="send-run-btn" :disabled="!canSend">
        <UiIcon :name="sending ? 'loader' : 'send'" :size="14" />{{ sending ? '正在发送…' : retryContext ? '发送并重跑' : '发送排查' }}
      </UiButton>
    </div>
  </form>
</template>

<style scoped>
.composer-controls, .retry-context { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px 7px; }
.composer-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; color: var(--text-secondary); font-size: 11px; }
.composer-controls :deep(button) { margin-inline-start: auto; flex: none; }
.retry-context { padding: 4px 8px; border-bottom: 1px solid var(--accent-soft-border); background: var(--accent-soft-bg); color: var(--accent-soft-fg); font-size: 12px; }
.retry-context span { min-width: 0; overflow-wrap: anywhere; }
.retry-context code { font-family: var(--font-mono); }
@media (max-width: 500px) { .composer-hint { display: none; } }
</style>
