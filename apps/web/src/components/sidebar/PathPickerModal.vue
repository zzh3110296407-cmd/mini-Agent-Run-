<script setup lang="ts">
import type { CreateSessionRequest, FsBrowseEntry } from '@mini-agent-run/shared';
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { usePathBrowser, type PathError } from '../../composables/usePathBrowser';
import { isTextEntry } from '../../utils/isTextEntry';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiEmpty from '../ui/UiEmpty.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ open: boolean; creating: boolean; creationError: PathError | null }>();
const emit = defineEmits<{ close: []; confirm: [input: CreateSessionRequest]; clearError: [] }>();
const { browseState, loading, errorState, selectedPath, browse, selectRoot, goParent, reset } = usePathBrowser();
const manualPath = ref('');
const sessionTitle = ref('');
const list = ref<HTMLElement | null>(null);
const inputId = useId();
const targetPath = computed(() => manualPath.value.trim() || (selectedPath.value ?? browseState.value?.currentPath ?? ''));
const displayedError = computed(() => props.creationError ?? errorState.value);
const errorClass = computed(() => displayedError.value?.severity.replace('_', '-'));
const canSubmit = computed(() => Boolean(targetPath.value) && !props.creating && (!loading.value || manualPath.value.trim() !== ''));

watch(() => props.open, (open) => {
  reset();
  manualPath.value = '';
  sessionTitle.value = '';
  if (open) void browse();
}, { immediate: true });
onUnmounted(reset);

function clearError() {
  errorState.value = null;
  emit('clearError');
}

function rows() {
  return Array.from(list.value?.querySelectorAll<HTMLButtonElement>('[data-testid="fs-entry-row"]') ?? []);
}

async function openDirectory(action: () => Promise<boolean>) {
  manualPath.value = '';
  clearError();
  if (!await action()) return;
  await nextTick();
  rows()[0]?.focus();
}

function navigate(entry: FsBrowseEntry) {
  if (entry.kind === 'dir') {
    void openDirectory(() => browse(entry.path));
  } else if (!loading.value) {
    manualPath.value = '';
    clearError();
    selectedPath.value = selectedPath.value === entry.path ? null : entry.path;
  }
}

function browseManual() {
  const path = manualPath.value.trim();
  if (!path) return;
  clearError();
  void browse(path);
}

function handleNavigation(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented || props.creating || isTextEntry(event.target)) return;
  if (event.key === 'Backspace') {
    event.preventDefault();
    if (browseState.value?.parentPath != null) void openDirectory(goParent);
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
  const buttons = rows();
  const index = buttons.findIndex((button) => button === document.activeElement || button === event.target);
  if (event.key === 'Enter') {
    const entry = browseState.value?.entries[index];
    if (!entry) return;
    event.preventDefault();
    navigate(entry);
    return;
  }
  if (buttons.length === 0) return;
  event.preventDefault();
  const shift = event.key === 'ArrowDown' ? 1 : -1;
  const next = index === -1 && shift === -1 ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + shift));
  buttons[next]?.focus();
}

function submit() {
  if (!canSubmit.value) return;
  clearError();
  const title = sessionTitle.value.trim();
  emit('confirm', { targetPath: targetPath.value, ...(title ? { title } : {}) });
}
</script>

<template>
  <UiDialog
    :open="open" title="新建排查会话" data-testid="path-picker-modal" :aria-busy="creating"
    style="--dialog-width: 620px" @close="emit('close')" @keydown="handleNavigation"
  >
    <form :id="inputId + '-form'" class="path-form" @submit.prevent="submit">
      <div v-if="browseState?.allowedRoots.length" class="roots" aria-label="允许的根目录">
        <UiButton
          v-for="root in browseState.allowedRoots" :key="root" size="sm"
          :variant="browseState.currentPath === root ? 'subtle' : 'default'"
          data-testid="allowed-root-chip" :title="root" :aria-pressed="browseState.currentPath === root"
          :disabled="creating" @click="openDirectory(() => selectRoot(root))"
        ><UiIcon name="folder" :size="14" /><span class="root-path">{{ root }}</span></UiButton>
      </div>
      <div class="browser" :aria-busy="loading">
        <div class="breadcrumb">
          <UiButton
            size="sm" variant="ghost" aria-label="返回上级目录" title="返回上级目录"
            data-testid="path-parent-btn" :disabled="browseState?.parentPath == null || creating"
            @click="openDirectory(goParent)"
          ><UiIcon name="corner-left-up" /></UiButton>
          <code v-if="browseState" data-testid="current-path" :title="browseState.currentPath">{{ browseState.currentPath }}</code>
          <span v-else class="muted">目录浏览</span>
          <span v-if="loading" class="muted" role="status">读取中…</span>
        </div>
        <div ref="list" class="entries" aria-label="目录内容">
          <button
            v-for="entry in browseState?.entries" :key="entry.path" type="button" class="fs-entry"
            :class="{ selected: selectedPath === entry.path }" data-testid="fs-entry-row" :data-entry-kind="entry.kind"
            :data-entry-path="entry.path" :title="entry.path" :disabled="creating"
            :aria-pressed="entry.kind === 'file' ? selectedPath === entry.path : undefined" @click="navigate(entry)"
          >
            <UiIcon :name="entry.kind === 'dir' ? 'folder' : 'file-text'" />
            <span>{{ entry.name }}</span>
            <UiIcon v-if="entry.kind === 'dir'" class="entry-end" name="chevron-right" :size="14" />
            <UiIcon v-else-if="selectedPath === entry.path" class="entry-end" name="check" :size="14" />
          </button>
          <UiEmpty
            v-if="browseState && !loading && browseState.entries.length === 0" title="此目录没有可浏览的条目"
          >仍可使用当前目录创建会话。</UiEmpty>
        </div>
      </div>
      <p
        v-if="displayedError" :id="inputId + '-error'" class="uiv-path-error" :class="'uiv-path-error--' + errorClass"
        role="alert" data-testid="path-error-banner" :data-error-code="displayedError.code"
      ><strong v-if="displayedError.status">{{ displayedError.status }} · </strong>{{ displayedError.message }}</p>
      <div class="field">
        <label :for="inputId">手动输入路径</label>
        <div class="path-input-row">
          <input
            :id="inputId" v-model="manualPath" class="field-input uiv-path-input" data-testid="manual-path-input"
            :class="errorClass ? 'uiv-path-input--' + errorClass : undefined" :aria-invalid="Boolean(displayedError)"
            :aria-describedby="displayedError ? inputId + '-error' : undefined" :disabled="creating"
            spellcheck="false" autocomplete="off" placeholder="粘贴绝对或相对路径" @input="clearError"
          >
          <UiButton data-testid="browse-manual-path-btn" :disabled="!manualPath.trim() || creating" @click="browseManual">
            浏览此路径
          </UiButton>
        </div>
      </div>
      <div class="field">
        <label :for="inputId + '-title'">会话标题 <span class="muted">（可选）</span></label>
        <input
          :id="inputId + '-title'" v-model="sessionTitle" data-testid="session-title-input" class="field-input"
          :disabled="creating" placeholder="默认使用文件夹或文件名"
        >
      </div>
    </form>
    <template #footer>
      <UiButton variant="ghost" :disabled="creating" @click="emit('close')">取消</UiButton>
      <UiButton
        variant="primary" type="submit" :form="inputId + '-form'" data-testid="confirm-create-session-btn"
        :disabled="!canSubmit" @click.prevent="submit"
      >{{ creating ? '正在创建…' : '创建会话' }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.path-form { display: grid; gap: 12px; }
.roots { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.roots button { max-width: 100%; }
.root-path, .breadcrumb code, .fs-entry span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.root-path, .breadcrumb code { font-family: var(--font-mono); }
.browser { min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-muted); }
.breadcrumb {
  display: flex; align-items: center; gap: 7px; padding: 5px 8px; min-width: 0;
  border-bottom: 1px solid var(--border-subtle); color: var(--text-code);
}
.breadcrumb button, .breadcrumb [role="status"] { flex: none; }
.entries { display: grid; padding: 5px; min-height: 65px; max-height: clamp(88px, 34dvh, 270px); overflow: auto; }
.fs-entry {
  display: flex; align-items: center; gap: 8px; text-align: left; min-height: 31px; padding: 3px 8px;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
}
.fs-entry svg { color: var(--text-secondary); }
.fs-entry:hover { background: var(--bg-hover); }
.fs-entry:focus-visible { outline-offset: -2px; }
.fs-entry.selected { background: var(--accent-soft-bg); border-color: var(--accent-soft-border); }
.fs-entry.selected svg { color: var(--accent-soft-fg); }
.entry-end { margin-inline-start: auto; }
.field { display: grid; gap: 5px; }
.field label { font-weight: 550; }
.path-input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.muted { color: var(--text-secondary); font-size: 12px; }
</style>
