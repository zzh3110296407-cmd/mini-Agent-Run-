<script setup lang="ts">
import type { SessionId, SessionListItem } from '@mini-agent-run/shared';
import { nextTick, ref } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiEmpty from '../ui/UiEmpty.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiKbd from '../ui/UiKbd.vue';
import SessionListItemCard from './SessionListItemCard.vue';

withDefaults(defineProps<{
  sessions: SessionListItem[];
  activeSessionId: SessionId | null;
  filterQuery: string;
  loading: boolean;
  errorMessage: string;
  hasCustomApiKey: boolean;
  showHeading?: boolean;
}>(), { showHeading: true });
const emit = defineEmits<{
  create: [];
  select: [id: SessionId];
  rename: [id: SessionId, title: string];
  requestDelete: [session: SessionListItem];
  settings: [];
  retry: [];
  'update:filterQuery': [query: string];
}>();
const filter = ref<HTMLInputElement | null>(null);

function updateFilter(event: Event) {
  if (event.target instanceof HTMLInputElement) emit('update:filterQuery', event.target.value);
}

async function clearFilter() {
  emit('update:filterQuery', '');
  await nextTick();
  filter.value?.focus();
}
</script>

<template>
  <div class="sidebar" aria-label="排查会话">
    <div class="sidebar-header">
      <h2 v-if="showHeading">排查会话</h2>
      <UiButton variant="subtle" class="new-session" data-testid="new-session-btn" @click="emit('create')">
        <UiIcon name="plus" />新建排查会话
      </UiButton>
      <div class="uiv-filter-box">
        <UiIcon class="uiv-filter-icon" name="search" :size="15" />
        <input
          ref="filter" data-testid="session-filter-input" data-autofocus type="search" :value="filterQuery"
          aria-label="筛选会话" aria-keyshortcuts="/" spellcheck="false"
          placeholder="筛选标题或路径" @input="updateFilter"
        >
        <UiButton v-if="filterQuery" variant="ghost" size="sm" aria-label="清除筛选" @click="clearFilter">
          <UiIcon name="x" :size="13" />
        </UiButton>
        <UiKbd v-else aria-hidden="true">/</UiKbd>
      </div>
    </div>
    <div class="sidebar-content" :aria-busy="loading">
      <div v-if="errorMessage" class="sidebar-error" role="alert">
        <span>{{ errorMessage }}</span>
        <UiButton variant="ghost" size="sm" @click="emit('retry')">重试</UiButton>
      </div>
      <p v-if="loading && sessions.length === 0" class="loading" role="status">正在读取会话…</p>
      <div role="list" aria-label="会话列表" class="session-list">
        <SessionListItemCard
          v-for="session in sessions" :key="session.id" :session="session" :active="session.id === activeSessionId"
          @select="emit('select', session.id)" @rename="(title) => emit('rename', session.id, title)"
          @request-delete="emit('requestDelete', session)"
        />
      </div>
      <UiEmpty
        v-if="!loading && !errorMessage && sessions.length === 0"
        :title="filterQuery.trim() ? '没有匹配的会话' : '暂无排查会话'"
      >{{ filterQuery.trim() ? '试试其他标题或路径。' : '创建会话以绑定轨迹文件或目录。' }}</UiEmpty>
    </div>
    <footer class="sidebar-footer">
      <UiButton variant="ghost" class="settings" data-testid="open-settings-btn" @click="emit('settings')">
        <UiIcon name="settings" />设置
        <span v-if="hasCustomApiKey" class="settings-dot" aria-label="已保存自定义 API Key" title="已保存自定义 API Key" />
      </UiButton>
    </footer>
  </div>
</template>

<style scoped>
.sidebar { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.sidebar-header { display: grid; gap: 9px; padding: 13px 10px 9px; }
.sidebar-header h2 { margin: 0 2px 1px; font-size: 13px; font-weight: 650; }
.new-session, .settings { justify-content: flex-start; }
.uiv-filter-box button { min-height: 22px; margin-inline-end: -3px; padding-inline: 4px; }
.sidebar-content { min-height: 0; flex: 1; overflow: auto; padding: 2px 8px 10px; }
.session-list { display: grid; gap: 4px; }
.session-list:empty { display: none; }
.sidebar-error {
  display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 7px; padding: 5px;
  color: var(--status-failed-fg); font-size: 12px; border: 1px solid var(--status-failed-border); border-radius: var(--radius-sm);
}
.loading { margin: 5px; color: var(--text-secondary); }
.sidebar-footer { flex: none; border-top: 1px solid var(--border-subtle); padding: 7px 8px; }
.settings { width: 100%; }
.settings-dot { margin-inline-start: auto; width: 7px; height: 7px; border-radius: 50%; background: var(--status-completed-fg); }
</style>
