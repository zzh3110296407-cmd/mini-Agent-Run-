<script setup lang="ts">
withDefaults(defineProps<{
  tone?: 'neutral' | 'accent' | 'running' | 'completed' | 'stopped' | 'failed' | 'warn' | 'info';
}>(), { tone: 'neutral' });
</script>

<template>
  <span class="ui-badge" :class="tone"><slot /></span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 1px 7px;
  border: 1px solid var(--badge-border, var(--status-pending-border));
  border-radius: 999px;
  color: var(--badge-fg, var(--status-pending-fg));
  background: var(--badge-bg, var(--status-pending-bg));
  font-size: 12px;
  line-height: 17px;
  white-space: nowrap;
}
.accent { --badge-fg: var(--accent-soft-fg); --badge-border: var(--accent-soft-border); --badge-bg: var(--accent-soft-bg); }
.running { --badge-fg: var(--status-running-fg); --badge-border: var(--status-running-border); --badge-bg: var(--status-running-bg); }
.completed { --badge-fg: var(--status-completed-fg); --badge-border: var(--status-completed-border); --badge-bg: var(--status-completed-bg); }
.stopped { --badge-fg: var(--status-stopped-fg); --badge-border: var(--status-stopped-border); --badge-bg: var(--status-stopped-bg); }
.failed { --badge-fg: var(--status-failed-fg); --badge-border: var(--status-failed-border); --badge-bg: var(--status-failed-bg); }
.warn { --badge-fg: var(--status-warn-fg); --badge-border: var(--status-warn-border); --badge-bg: var(--status-warn-bg); }
.info { --badge-fg: var(--status-info-fg); --badge-border: var(--status-info-border); --badge-bg: var(--status-info-bg); }
</style>
