<script setup lang="ts">
import type { HighSignalTargets, JumpTarget } from '../../utils/runTimelineReducer';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

defineProps<{ signals: HighSignalTargets }>();
const emit = defineEmits<{ jump: [target: JumpTarget, label: string] }>();
const entries = [
  { kind: 'firstError', id: 'jump-first-error-btn', label: '首错', icon: 'alert-circle' },
  { kind: 'retryLoop', id: 'jump-retry-loop-btn', label: '重试循环', icon: 'rotate-ccw' },
  { kind: 'slowTool', id: 'jump-slow-tool-btn', label: '慢调用', icon: 'clock' },
] as const;

function select(target: JumpTarget | null, label: string) {
  if (target) emit('jump', target, label);
}
</script>

<template>
  <div
    v-if="signals.firstError || signals.retryLoop || signals.slowTool" class="jump-bar"
    role="toolbar" aria-label="高信号跳转" data-testid="high-signal-jump-bar"
  >
    <template v-for="entry in entries" :key="entry.kind">
      <UiButton
        v-if="signals[entry.kind]" variant="ghost" size="sm" :data-testid="entry.id"
        @click="select(signals[entry.kind], entry.label)"
      ><UiIcon :name="entry.icon" :size="14" />{{ entry.label }}</UiButton>
    </template>
  </div>
</template>

<style scoped>
.jump-bar { display: flex; flex-wrap: wrap; gap: 4px; }
[data-testid="jump-first-error-btn"] { color: var(--status-failed-fg); }
[data-testid="jump-retry-loop-btn"], [data-testid="jump-slow-tool-btn"] { color: var(--status-warn-fg); }
</style>
