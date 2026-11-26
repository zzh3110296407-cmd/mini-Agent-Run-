<script setup lang="ts">
import { COMPUTER_ROOT_PATH, type CreateSessionRequest, type FsBrowseEntry } from '@mini-agent-run/shared';
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { usePathBrowser, type PathError } from '../../composables/usePathBrowser';
import { isTextEntry } from '../../utils/isTextEntry';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiEmpty from '../ui/UiEmpty.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ open: boolean; creating: boolean; creationError: PathError | null }>();
const emit = defineEmits<{ close: []; confirm: [input: CreateSessionRequest]; clearError: [] }>();
const { browseState, loading, errorState, selectedPath, browse, cancelBrowse, reset } = usePathBrowser();
const defaultTitle = '新建排查会话';
const address = ref('');
const sessionTitle = ref('');
const titleDraft = ref('');
const editingTitle = ref(false);
const titleInput = ref<HTMLInputElement | null>(null);
const titleTrigger = ref<HTMLButtonElement | null>(null);
const list = ref<HTMLElement | null>(null);
const inputId = useId();
const computerView = computed(() => browseState.value?.currentPath === COMPUTER_ROOT_PATH);
const targetPath = computed(() => selectedPath.value ?? (computerView.value ? '' : browseState.value?.currentPath ?? ''));
const confirmedPath = computed(() => Boolean(targetPath.value) && address.value.trim() === targetPath.value
  && !loading.value && !errorState.value);
const targetKind = computed(() => confirmedPath.value ? (selectedPath.value ? '单文件' : '目录') : '未选择');
const targetName = computed(() => {
  const path = address.value.trim();
  if (path === selectedPath.value) {
    const selected = browseState.value?.entries.find((entry) => entry.path === path);
    if (selected) return selected.name;
  }
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
});
const displayedError = computed(() => props.creationError ?? errorState.value);
const errorClass = computed(() => displayedError.value?.severity.replace('_', '-'));
const canSubmit = computed(() => confirmedPath.value && !props.creating);
let addressTimer: ReturnType<typeof setTimeout> | undefined;
let addressComposing = false;
let pendingAddress: { path: string } | undefined;
let pointerNavigation: Element | null = null;

watch(() => props.open, (open) => {
  stopAddressWork();
  reset();
  address.value = '';
  sessionTitle.value = '';
  editingTitle.value = false;
  addressComposing = false;
  if (open) void loadDirectory();
}, { immediate: true });
onUnmounted(() => {
  stopAddressWork();
  reset();
});

function clearError() {
  errorState.value = null;
  emit('clearError');
}

function stopTimer() {
  clearTimeout(addressTimer);
  addressTimer = undefined;
}

function stopAddressWork() {
  stopTimer();
  clearPointerNavigation();
  pendingAddress = undefined;
  cancelBrowse();
}

function close() {
  stopAddressWork();
  emit('close');
}

async function loadDirectory(path?: string) {
  if (!await browse(path)) return false;
  address.value = targetPath.value;
  return true;
}

function updateAddress(value: string) {
  if (value !== address.value) stopAddressWork();
  address.value = value;
  clearError();
}

async function jumpToAddress() {
  stopTimer();
  const path = address.value.trim();
  if (addressComposing || props.creating || !path || path === targetPath.value || path === pendingAddress?.path) return;
  const request = { path };
  pendingAddress = request;
  if (await browse(path, { resolveFile: true })) address.value = targetPath.value;
  if (pendingAddress === request) pendingAddress = undefined;
}

function scheduleAddress(event: Event) {
  const input = event.target as HTMLInputElement;
  updateAddress(input.value);
  stopTimer();
  if (addressComposing || (event instanceof InputEvent && event.isComposing)) return;
  const path = address.value.trim();
  if (path && path !== targetPath.value && path !== pendingAddress?.path) {
    addressTimer = setTimeout(() => void jumpToAddress(), 350);
  }
}

function pasteAddress(event: ClipboardEvent) {
  const input = event.target as HTMLInputElement;
  stopTimer();
  if (event.clipboardData) {
    event.preventDefault();
    input.setRangeText(event.clipboardData.getData('text/plain'), input.selectionStart ?? 0,
      input.selectionEnd ?? input.value.length, 'end');
    updateAddress(input.value);
    void jumpToAddress();
    return;
  }
  addressTimer = setTimeout(() => {
    updateAddress(input.value);
    void jumpToAddress();
  }, 0);
}

function startComposition() {
  addressComposing = true;
  stopAddressWork();
}

function finishComposition(event: CompositionEvent) {
  addressComposing = false;
  scheduleAddress(event);
}

function addressEnter(event: KeyboardEvent) {
  if (!event.isComposing) void jumpToAddress();
}

function addressBlur(event: FocusEvent) {
  const isPointerNavigation = pointerNavigation !== null && event.relatedTarget === pointerNavigation;
  clearPointerNavigation();
  if (isPointerNavigation) return;
  void jumpToAddress();
}

function clearPointerNavigation() {
  pointerNavigation = null;
}

function handlePointerDown(event: PointerEvent) {
  if (!(event.target instanceof Element) || event.button !== 0) return;
  pointerNavigation = event.target.closest(
    '[data-testid="fs-entry-row"], [data-testid="path-parent-btn"], [data-testid="path-picker-cancel"], button[aria-label="关闭"]',
  );
  if (pointerNavigation) stopTimer();
}

async function editTitle() {
  titleDraft.value = sessionTitle.value;
  editingTitle.value = true;
  await nextTick();
  titleInput.value?.focus();
  titleInput.value?.select();
}

function commitTitle() {
  if (!editingTitle.value) return;
  const title = titleDraft.value.trim();
  sessionTitle.value = title === defaultTitle ? '' : title;
  editingTitle.value = false;
}

async function finishTitle(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Enter') commitTitle();
  else editingTitle.value = false;
  await nextTick();
  titleTrigger.value?.focus();
}

function rows() {
  return Array.from(list.value?.querySelectorAll<HTMLButtonElement>('[data-testid="fs-entry-row"]') ?? []);
}

async function openDirectory(path: string) {
  stopAddressWork();
  clearError();
  address.value = path === COMPUTER_ROOT_PATH ? '' : path;
  if (!await loadDirectory(path)) return;
  await nextTick();
  rows()[0]?.focus();
}

function goParent() {
  const parent = browseState.value?.parentPath;
  if (parent != null) void openDirectory(parent);
}

function navigate(entry: FsBrowseEntry) {
  if (entry.kind === 'dir') {
    void openDirectory(entry.path);
  } else {
    stopAddressWork();
    clearError();
    selectedPath.value = selectedPath.value === entry.path ? null : entry.path;
    address.value = targetPath.value;
  }
}

function handleNavigation(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented || props.creating || isTextEntry(event.target)) return;
  if (event.key === 'Backspace') {
    event.preventDefault();
    goParent();
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
  commitTitle();
  clearError();
  const title = sessionTitle.value;
  emit('confirm', { targetPath: targetPath.value, ...(title ? { title } : {}) });
}
</script>

<template>
  <UiDialog
    :open="open" :title="defaultTitle" data-testid="path-picker-modal" :aria-busy="creating"
    style="--dialog-width: 620px" @close="close" @keydown="handleNavigation"
    @pointerdown.capture="handlePointerDown" @pointerup.capture="clearPointerNavigation"
    @pointercancel.capture="clearPointerNavigation"
  >
    <template #title="{ titleId }">
      <div class="title-editor">
        <h2 :id="titleId" class="picker-title">
          <button
            v-if="!editingTitle" ref="titleTrigger" type="button" class="title-trigger"
            data-testid="session-title-trigger" title="点击自定义会话标题" :disabled="creating" @click="editTitle"
          ><span>{{ sessionTitle || defaultTitle }}</span><UiIcon name="pencil" :size="13" /></button>
          <span v-else class="sr-only">{{ sessionTitle || defaultTitle }}</span>
        </h2>
        <input
          v-if="editingTitle" ref="titleInput" v-model="titleDraft" class="field-input title-input"
          data-testid="session-title-input" aria-label="会话标题" :disabled="creating"
          placeholder="留空则默认使用文件夹或文件名" @blur="commitTitle"
          @keydown.enter.stop.prevent="finishTitle" @keydown.esc.stop.prevent="finishTitle"
        >
      </div>
    </template>
    <form :id="inputId + '-form'" class="path-form" @submit.prevent="submit">
      <div class="browser" :aria-busy="loading">
        <div class="address-bar">
          <UiButton
            size="sm" variant="ghost" aria-label="返回上级目录" title="返回上级目录"
            data-testid="path-parent-btn" :disabled="browseState?.parentPath == null || creating"
            @click="goParent"
          ><UiIcon name="corner-left-up" /></UiButton>
          <input
            :id="inputId" :value="address" class="field-input uiv-path-input" data-testid="path-address-input"
            :class="errorClass ? 'uiv-path-input--' + errorClass : undefined" :aria-invalid="Boolean(displayedError)"
            :aria-describedby="displayedError ? inputId + '-error' : undefined" :disabled="creating"
            :placeholder="computerView ? '选择盘符或粘贴路径' : '输入或粘贴文件夹或文件路径'"
            aria-label="文件或目录路径" spellcheck="false" autocomplete="off" data-autofocus
            @input="scheduleAddress" @paste="pasteAddress" @keydown.enter.stop.prevent="addressEnter" @blur="addressBlur"
            @keydown.tab="clearPointerNavigation"
            @compositionstart="startComposition" @compositionend="finishComposition"
          >
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
    </form>
    <template #footer>
      <div class="selection-summary" data-testid="path-selection-summary">
        <span class="selection-kind" :class="{ 'selection-kind--confirmed': confirmedPath }">{{ targetKind }}</span>
        <span class="selection-name" :title="address.trim()">{{ targetName }}</span>
      </div>
      <div class="footer-actions">
        <UiButton variant="ghost" data-testid="path-picker-cancel" :disabled="creating" @click="close">取消</UiButton>
        <UiButton
          variant="primary" type="submit" :form="inputId + '-form'" data-testid="confirm-create-session-btn"
          :disabled="!canSubmit" @click.prevent="submit"
        >{{ creating ? '正在创建…' : '创建会话' }}</UiButton>
      </div>
    </template>
  </UiDialog>
</template>

<style scoped>
.path-form { display: grid; gap: 12px; }
.title-editor { flex: 1; min-width: 0; }
.picker-title { margin: 0; font-size: 15px; font-weight: 600; }
.title-trigger {
  display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-height: 29px;
  padding: 0 6px; border-radius: var(--radius-sm); color: var(--text-primary); font-weight: 600; text-align: left;
}
.title-trigger:hover:not(:disabled) { background: var(--bg-hover); }
.title-trigger svg { color: var(--text-secondary); flex: none; }
.title-input { width: min(100%, 360px); min-height: 29px; padding-block: 3px; }
.title-trigger span, .fs-entry span, .selection-name {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.browser { min-width: 0; overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-muted); }
.address-bar {
  display: flex; align-items: center; gap: 7px; padding: 5px 8px; min-width: 0;
  border-bottom: 1px solid var(--border-subtle);
}
.address-bar input { flex: 1; min-width: 0; }
.address-bar button, .address-bar [role="status"] { flex: none; }
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
.selection-summary, .footer-actions { display: flex; align-items: center; gap: 8px; }
.selection-summary { flex: 1; min-width: 0; }
.selection-kind {
  flex: none; padding: 2px 6px; border-radius: var(--radius-sm);
  color: var(--text-secondary); background: var(--bg-muted); font-size: 12px;
}
.selection-kind--confirmed { color: var(--accent-soft-fg); background: var(--accent-soft-bg); }
.selection-name { color: var(--text-secondary); font: 12px var(--font-mono); }
.footer-actions { flex: none; }
.muted { color: var(--text-secondary); font-size: 12px; }
</style>
