<script setup lang="ts">
import type { SessionListItem } from '@mini-agent-run/shared';
import { computed, nextTick, ref } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ session: SessionListItem; active: boolean }>();
const emit = defineEmits<{ select: []; rename: [title: string]; requestDelete: [] }>();
const editing = ref(false);
const draft = ref('');
const invalid = ref(false);
const input = ref<HTMLInputElement | null>(null);
const pick = ref<HTMLButtonElement | null>(null);
const leaf = computed(() => props.session.targetPath.split(/[\\/]/).filter(Boolean).at(-1) ?? props.session.targetPath);
const pathType = computed(() => props.session.pathType === 'dir' ? '目录' : '文件');

async function beginRename() {
  draft.value = props.session.title;
  invalid.value = false;
  editing.value = true;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}

async function finishEditing() {
  editing.value = false;
  invalid.value = false;
  await nextTick();
  pick.value?.focus();
}

function editKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    void finishEditing();
  }
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = draft.value.trim();
  if (!value) {
    invalid.value = true;
    return;
  }
  if (value !== props.session.title) emit('rename', value);
  void finishEditing();
}
</script>

<template>
  <article
    class="session-card" :class="{ active }" role="listitem" data-testid="session-item" :data-session-id="session.id"
    :data-active="String(active)" :data-running="String(session.hasActiveRun)" @click="emit('select')"
  >
    <div v-if="editing" class="session-edit" @click.stop>
      <input
        ref="input" v-model="draft" class="field-input" :aria-invalid="invalid" data-testid="session-rename-input"
        aria-label="会话标题" @input="invalid = false" @keydown="editKey"
      >
      <span v-if="invalid" role="alert">会话标题不能为空。</span>
    </div>
    <button v-else ref="pick" type="button" class="session-pick" :aria-current="active ? 'true' : undefined">
      <span class="session-title">
        <span v-if="session.hasActiveRun" class="run-dot" aria-label="排查中" />
        <span class="truncate" :title="session.title">{{ session.title }}</span>
      </span>
      <span class="session-meta">
        <UiIcon :name="session.pathType === 'dir' ? 'folder' : 'file-text'" :size="13" />
        <span class="truncate path" :title="session.targetPath" aria-hidden="true">{{ leaf }}</span>
        <span class="sr-only">{{ session.targetPath }}</span>
        <span class="path-type">{{ pathType }}</span>
        <span class="tabular-nums run-count" :title="session.runCount + ' 次排查'">{{ session.runCount }}</span>
      </span>
    </button>
    <div v-if="!editing" class="session-actions">
      <UiButton
        size="sm" variant="ghost" aria-label="重命名会话" title="重命名会话"
        data-testid="session-rename-btn" @click.stop="beginRename"
      ><UiIcon name="pencil" :size="13" /></UiButton>
      <UiButton
        size="sm" variant="ghost" aria-label="删除会话" title="删除会话"
        data-testid="session-delete-btn" @click.stop="emit('requestDelete')"
      ><UiIcon name="trash-2" :size="13" /></UiButton>
    </div>
  </article>
</template>

<style scoped>
.session-card {
  position: relative; display: flex; align-items: stretch; min-width: 0;
  border: 1px solid transparent; border-radius: var(--radius-md);
}
.session-card.active { border-color: var(--accent-soft-border); background: var(--bg-active); }
.session-card:hover:not(.active) { background: var(--bg-hover); }
.session-pick {
  display: grid; flex: 1; min-width: 0; align-content: center; gap: 3px;
  border: 0; border-radius: var(--radius-sm); padding: 7px 8px;
  background: transparent; text-align: left;
}
.session-title, .session-meta, .session-actions { display: flex; min-width: 0; align-items: center; gap: 5px; }
.session-title { font-weight: 550; }
.session-meta { color: var(--text-secondary); font-size: 11.5px; line-height: 16px; }
.truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path { font-family: var(--font-mono); }
.path-type, .run-count { flex: none; }
.path-type { margin-inline-start: auto; }
.run-count { padding-inline: 4px; border-radius: var(--radius-xs); background: var(--bg-muted); }
.run-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--status-running-dot); animation: pulse 1.6s ease-in-out infinite; }
.session-actions { flex: none; gap: 0; padding: 3px 2px 0 0; align-self: flex-start; opacity: .65; }
.session-card:hover .session-actions, .session-card:focus-within .session-actions { opacity: 1; }
.session-actions button { padding-inline: 4px; min-height: 23px; }
.session-edit { width: 100%; padding: 5px; }
.session-edit [role="alert"] { color: var(--status-failed-fg); font-size: 12px; }
.session-edit input[aria-invalid="true"] { border-color: var(--status-failed-border); }
@keyframes pulse { 50% { opacity: .55; } }
</style>
