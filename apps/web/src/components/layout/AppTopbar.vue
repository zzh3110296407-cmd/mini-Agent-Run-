<script setup lang="ts">
import { computed } from 'vue';
import type { WorkbenchTheme } from '../../composables/useWorkbenchLayout';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{
  theme: WorkbenchTheme;
  health: 'online' | 'offline' | 'loading';
  showSidebarToggle: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
}>();
const emit = defineEmits<{ retryHealth: []; toggleSidebar: []; toggleTheme: []; toggleInspector: [] }>();

const labels = {
  online: { text: '在线', tone: 'completed', icon: 'check-circle' },
  offline: { text: '离线', tone: 'failed', icon: 'alert-circle' },
  loading: { text: '检测中', tone: 'neutral', icon: 'loader' },
} as const;
const connection = computed(() => labels[props.health]);
</script>

<template>
  <header class="topbar">
    <div class="topbar-left">
      <UiButton
        v-if="showSidebarToggle" variant="ghost" size="sm" data-testid="toggle-sidebar-btn" aria-label="切换会话侧栏"
        aria-controls="sidebar-pane" :aria-expanded="sidebarOpen" @click="emit('toggleSidebar')"
      ><UiIcon name="panel-left" /></UiButton>
      <div class="brand"><span class="brand-mark" aria-hidden="true">›_</span><span>Mini Agent Run <span class="brand-label">排查台</span></span></div>
    </div>
    <div class="topbar-actions">
      <div role="status" data-testid="health-status-badge">
        <button type="button" class="health" title="重新检查后端连接" @click="emit('retryHealth')">
          <UiBadge :tone="connection.tone"><UiIcon :name="connection.icon" :size="13" />{{ connection.text }}</UiBadge>
        </button>
      </div>
      <UiButton
        variant="ghost" size="sm" data-testid="toggle-theme-btn"
        :aria-label="theme === 'dark' ? '使用亮色主题' : '使用深色主题'" @click="emit('toggleTheme')"
      ><UiIcon :name="theme === 'dark' ? 'sun' : 'moon'" /></UiButton>
      <UiButton
        variant="ghost" size="sm" data-testid="toggle-inspector-btn" aria-label="切换日志检视器"
        aria-controls="inspector-panel" :aria-expanded="inspectorOpen" @click="emit('toggleInspector')"
      ><UiIcon name="panel-right" /></UiButton>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-height);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
}
.topbar-left, .topbar-actions { display: flex; align-items: center; gap: 7px; }
.topbar-left { min-width: 0; }
.topbar-actions { flex: none; }
.brand { display: flex; align-items: center; flex: none; gap: 7px; font-weight: 650; white-space: nowrap; }
.brand-label { color: var(--text-secondary); font-weight: 500; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 23px;
  height: 22px;
  border: 1px solid var(--accent-soft-border);
  border-radius: var(--radius-sm);
  color: var(--accent-soft-fg);
  background: var(--accent-soft-bg);
  font: 700 14px/1 var(--font-mono);
}
.health { padding: 0; border: 0; border-radius: 999px; background: transparent; }
@media (max-width: 490px) {
  .topbar { padding-inline: 7px; gap: 5px; }
  .topbar-actions, .topbar-left { gap: 4px; }
  .brand-label { display: none; }
}
</style>
