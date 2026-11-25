<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="ui-empty">
    <slot name="icon" />
    <strong>{{ title }}</strong>
    <div v-if="$slots.default" class="ui-empty-note"><slot /></div>
  </div>
</template>

<style scoped>
.ui-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  text-align: center;
}
.ui-empty > :deep(svg) { color: var(--text-subtle-readable); }
strong { font-weight: 600; }
.ui-empty-note { color: var(--text-secondary); font-size: 12px; line-height: 18px; }
</style>
