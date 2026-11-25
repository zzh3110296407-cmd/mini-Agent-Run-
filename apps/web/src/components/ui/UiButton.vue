<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'default' | 'primary' | 'subtle' | 'ghost' | 'destructive';
  size?: 'sm' | 'md';
  type?: 'button' | 'submit' | 'reset';
}>(), { variant: 'default', size: 'md', type: 'button' });
</script>

<template>
  <button :type="type" class="ui-button" :class="[variant, size]"><slot /></button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  min-width: 0;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-weight: 550;
  white-space: nowrap;
  transition: background var(--duration-fast) ease, border-color var(--duration-fast) ease;
}
.ui-button.sm { min-height: 27px; padding-inline: 6px; font-size: 12px; }
.ui-button:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.ui-button:disabled { opacity: .55; }
.ui-button.primary { background: var(--accent-primary-hover); border-color: var(--accent-primary); color: var(--accent-primary-fg); }
.ui-button.primary:hover:not(:disabled) { background: var(--accent-primary); border-color: var(--accent-primary); }
.ui-button.subtle { background: var(--accent-soft-bg); border-color: var(--accent-soft-border); color: var(--accent-soft-fg); }
.ui-button.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
.ui-button.destructive { background: var(--status-failed-solid-hover); border-color: var(--status-failed-solid); color: white; }
.ui-button.destructive:hover:not(:disabled) { background: var(--status-failed-solid); border-color: var(--status-failed-solid); }
</style>
