<script setup lang="ts">
import { computed } from 'vue';
import type { InspectorTargetRequest } from '../../composables/useRunStream';

const props = defineProps<{ target: InspectorTargetRequest; targetPath: string }>();
const identifier = computed(() => props.target.mode === 'artifact' ? props.target.artifactId : props.target.file ?? props.targetPath);
const lines = computed(() => {
  const { line, endLine } = props.target;
  if (line === undefined) return '';
  return endLine !== undefined && endLine !== line ? 'L' + line + '–L' + endLine : 'L' + line;
});
</script>

<template>
  <section class="target-preview" data-testid="inspector-target-preview" :data-target-mode="target.mode" aria-label="当前检视目标">
    <h3>{{ target.label ?? '当前检视目标' }}</h3>
    <dl>
      <div><dt>类型</dt><dd>{{ target.mode === 'artifact' ? 'Artifact' : '文件' }}</dd></div>
      <div><dt>目标</dt><dd><code>{{ identifier }}</code></dd></div>
      <div v-if="lines"><dt>行号</dt><dd><code>{{ lines }}</code></dd></div>
      <div v-if="target.mode === 'file' && target.step !== undefined"><dt>步骤</dt><dd><code>Step #{{ target.step }}</code></dd></div>
    </dl>
  </section>
</template>

<style scoped>
.target-preview { display: grid; gap: 8px; padding: 11px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); overflow-wrap: anywhere; }
h3, dl, dd { margin: 0; }
h3 { font-size: 13px; }
dl { display: grid; gap: 5px; font-size: 12px; }
dl > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 4px; }
dt { color: var(--text-secondary); }
code { color: var(--text-code); font-family: var(--font-mono); }
</style>
