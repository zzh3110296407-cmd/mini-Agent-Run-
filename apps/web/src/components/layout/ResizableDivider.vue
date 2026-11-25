<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { clampInspectorWidth, maxInspectorWidth, minInspectorWidth } from '../../composables/useWorkbenchLayout';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ width: number }>();
const emit = defineEmits<{ 'update:width': [width: number] }>();
const dragging = ref(false);
let originX = 0;
let originWidth = 0;

function resize(width: number) {
  emit('update:width', clampInspectorWidth(width));
}

function move(event: MouseEvent) {
  resize(originWidth + originX - event.clientX);
}

function endDrag() {
  dragging.value = false;
  window.removeEventListener('mousemove', move);
  window.removeEventListener('mouseup', endDrag);
  window.removeEventListener('blur', endDrag);
}

function startDrag(event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  originX = event.clientX;
  originWidth = props.width;
  dragging.value = true;
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
}

onBeforeUnmount(endDrag);
</script>

<template>
  <div
    class="divider" :class="{ dragging }" data-testid="inspector-divider" role="separator" aria-orientation="vertical"
    aria-label="调整检视器宽度" aria-controls="inspector-panel" :aria-valuenow="width"
    :aria-valuemin="minInspectorWidth" :aria-valuemax="maxInspectorWidth" tabindex="0"
    @mousedown="startDrag" @keydown.left.prevent="resize(width + 24)" @keydown.right.prevent="resize(width - 24)"
  >
    <UiIcon name="grip-vertical" :size="12" />
  </div>
</template>

<style scoped>
.divider {
  position: relative;
  z-index: var(--z-resize-handle);
  width: 7px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  border-inline: 1px solid var(--border-subtle);
  background: var(--bg-muted);
  cursor: col-resize;
  user-select: none;
}
.divider:hover, .divider.dragging, .divider:focus-visible {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-fg);
}
</style>
