<script setup lang="ts">
import type { Session } from '@mini-agent-run/shared';
import UiBadge from '../ui/UiBadge.vue';
import UiIcon from '../ui/UiIcon.vue';

defineProps<{ session: Session; runCount: number; hasActiveRun: boolean }>();
</script>

<template>
  <section class="target-summary" aria-label="会话绑定">
    <div class="target-icon"><UiIcon :name="session.pathType === 'dir' ? 'folder-open' : 'file-text'" :size="18" /></div>
    <div class="target-content">
      <h2>绑定目标</h2>
      <code :title="session.targetPath">{{ session.targetPath }}</code>
      <div class="target-meta">
        <UiBadge>{{ session.pathType === 'dir' ? '目录' : '文件' }}</UiBadge>
        <UiBadge class="tabular-nums">{{ runCount }} 次排查</UiBadge>
        <UiBadge :tone="hasActiveRun ? 'running' : 'neutral'">{{ hasActiveRun ? '排查中' : '空闲' }}</UiBadge>
      </div>
    </div>
  </section>
</template>

<style scoped>
.target-summary {
  display: flex; align-items: flex-start; gap: 11px; padding: 13px; min-width: 0;
  border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-panel);
}
.target-icon {
  display: grid; place-items: center; width: 32px; height: 32px; flex: none;
  border: 1px solid var(--accent-soft-border); border-radius: var(--radius-sm);
  background: var(--accent-soft-bg); color: var(--accent-soft-fg);
}
.target-content { min-width: 0; }
h2 { margin: 0 0 3px; font-size: 13px; font-weight: 600; }
code { color: var(--text-code); font: 12.5px/20px var(--font-mono); overflow-wrap: anywhere; }
.target-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
</style>
