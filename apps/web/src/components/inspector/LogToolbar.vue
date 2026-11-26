<script setup lang="ts">
import { nextTick, onScopeDispose, ref, useId, watch } from 'vue';
import type { useLogInspector, LogLevelFilter } from '../../composables/useLogInspector';
import UiBadge from '../ui/UiBadge.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

const props = defineProps<{ inspector: ReturnType<typeof useLogInspector> }>();
const {
  sourceMode, fileOptions, filePickerOpen, fileListLoading, fileListError, selectedFilePath,
  activeArtifactId, activeArtifactMeta, slice, loading, loadingMore, focusRange, levelFilter, evidenceTarget,
  searchQuery, activeMatchIndex, changeQuery, changeLevel, chooseFile,
  navigateMatch, jumpToLine, returnToOriginalFile, retryFiles,
} = props.inspector;

const levels = ['all', 'error', 'warn', 'info'] as const satisfies readonly LogLevelFilter[];
const chooser = ref<HTMLElement | null>(null);
const pickerId = useId();
const draft = ref(searchQuery.value);
const copyStatus = ref('');
let debounce: ReturnType<typeof setTimeout> | undefined;

watch(filePickerOpen, async (opened) => {
  if (!opened) {
    await nextTick();
    chooser.value?.querySelector('button')?.focus();
  }
});
watch([searchQuery, sourceMode, selectedFilePath, activeArtifactId, evidenceTarget], ([value]) => {
  clearTimeout(debounce);
  draft.value = value;
});
watch(slice, () => { copyStatus.value = ''; });
onScopeDispose(() => clearTimeout(debounce));

function submitSearch() {
  clearTimeout(debounce);
  changeQuery(draft.value);
}

function inputSearch(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  draft.value = event.target.value;
  clearTimeout(debounce);
  if (!draft.value.trim()) submitSearch();
  else debounce = setTimeout(submitSearch, 220);
}

async function copy() {
  const current = slice.value;
  if (!current) return;
  const text = current.lines.map((line) => line.text).join('\n');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable.');
    await navigator.clipboard.writeText(text);
    if (slice.value === current) copyStatus.value = '已复制';
  } catch {
    if (slice.value === current) copyStatus.value = '无法复制';
  }
}

function jumpEvidence() {
  const line = focusRange.value?.startLine;
  if (line !== undefined) void jumpToLine(line);
}
</script>

<template>
  <div class="log-toolbar">
    <div class="toolbar-row source-row">
      <UiBadge data-testid="log-source-type" :data-source-mode="sourceMode" :tone="sourceMode === 'artifact' ? 'accent' : 'neutral'">
        {{ sourceMode === 'artifact' ? 'Artifact' : '原文件' }}
      </UiBadge>
      <span v-if="sourceMode === 'artifact'" class="source-name" :title="activeArtifactId ?? undefined">
        {{ activeArtifactMeta?.title ?? activeArtifactId }}
      </span>
      <span v-else class="source-name" :title="selectedFilePath ?? undefined">
        {{ fileOptions.find((entry) => entry.path === selectedFilePath)?.name ?? selectedFilePath }}
      </span>
      <UiButton v-if="sourceMode === 'artifact'" variant="subtle" size="sm" data-testid="return-to-original-file" @click="returnToOriginalFile">
        <UiIcon name="corner-left-up" :size="14" />返回原文件
      </UiButton>
      <div v-else ref="chooser" class="file-chooser">
        <UiButton
          variant="subtle" size="sm" data-testid="log-file-choose" :aria-controls="pickerId"
          :aria-expanded="filePickerOpen" @click="filePickerOpen = !filePickerOpen"
        >选择<UiIcon name="chevron-down" :size="13" /></UiButton>
        <div v-if="filePickerOpen" :id="pickerId" role="group" aria-label="可检视文件" class="file-options">
          <p v-if="fileListLoading" role="status">正在读取文件列表…</p>
          <template v-else-if="fileListError">
            <p role="alert">{{ fileListError }}</p>
            <UiButton variant="ghost" size="sm" @click="retryFiles">重试</UiButton>
          </template>
          <p v-else-if="!fileOptions.length">目录中没有可检视的文件。</p>
          <button
            v-for="option in fileOptions" :key="option.path" type="button" data-testid="log-file-option"
            :data-file-path="option.path" :aria-pressed="selectedFilePath === option.path"
            :title="option.path" @click="chooseFile(option.path)"
          >{{ option.name }}</button>
        </div>
      </div>
    </div>

    <form class="toolbar-row" @submit.prevent="submitSearch">
      <div class="search-control">
        <UiIcon name="search" :size="14" />
        <input
          :value="draft" type="search" data-testid="log-search-input" aria-label="搜索日志关键词"
          placeholder="搜索日志关键词" @input="inputSearch"
        >
      </div>
      <UiButton
        variant="ghost" size="sm" data-testid="log-search-prev" aria-label="上一处命中" title="上一处命中"
        :disabled="!searchQuery || !slice?.matchedLines || loading || loadingMore" @click="navigateMatch(-1)"
      ><UiIcon name="chevron-up" :size="14" /></UiButton>
      <UiButton
        variant="ghost" size="sm" data-testid="log-search-next" aria-label="下一处命中" title="下一处命中"
        :disabled="!searchQuery || !slice?.matchedLines || loading || loadingMore" @click="navigateMatch(1)"
      ><UiIcon name="chevron-down" :size="14" /></UiButton>
      <output v-if="searchQuery" class="match-count tabular-nums" data-testid="log-match-count" aria-live="polite">
        {{ activeMatchIndex + 1 }} / {{ slice?.matchedLines ?? 0 }} 命中
      </output>
    </form>

    <div class="toolbar-row display-controls">
      <div role="group" aria-label="日志级别" class="level-filter" data-testid="log-level-filter">
        <UiButton
          v-for="level in levels" :key="level" size="sm" :variant="levelFilter === level ? 'subtle' : 'ghost'"
          :aria-pressed="levelFilter === level" :data-log-level="level" @click="changeLevel(level)"
        >{{ level.toUpperCase() }}</UiButton>
      </div>
      <UiButton variant="ghost" size="sm" data-testid="log-copy-btn" :disabled="!slice?.lines.length" @click="copy">
        <UiIcon name="copy" :size="13" />复制
      </UiButton>
      <UiButton v-if="focusRange" size="sm" variant="ghost" data-testid="log-jump-evidence-btn" @click="jumpEvidence">
        <UiIcon name="zap" :size="13" />回到证据
      </UiButton>
      <span v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</span>
    </div>
  </div>
</template>

<style scoped>
.log-toolbar { display: grid; flex: none; gap: 5px; padding: 8px; border-bottom: 1px solid var(--border-subtle); }
.toolbar-row { display: flex; min-width: 0; align-items: center; gap: 4px; }
.source-name { flex: 1; min-width: 0; overflow: hidden; color: var(--text-secondary); font: 12px/18px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.file-chooser { position: relative; }
.file-options { position: absolute; z-index: 2; inset: calc(100% + 4px) 0 auto auto; width: min(270px, 65vw); max-height: 220px; overflow: auto; padding: 4px; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--bg-elevated); }
.file-options p { margin: 5px; color: var(--text-secondary); font-size: 12px; }
.file-options > button { display: block; width: 100%; padding: 6px; overflow: hidden; border: 0; border-radius: var(--radius-xs); background: transparent; color: inherit; text-align: start; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.file-options > button:hover, .file-options > button[aria-pressed="true"] { background: var(--accent-soft-bg); color: var(--accent-soft-fg); }
.search-control { display: flex; min-width: 4em; flex: 1; align-items: center; gap: 5px; padding-inline: 7px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); color: var(--text-secondary); }
.search-control:focus-within { border-color: var(--accent-primary); }
.search-control input { width: 100%; min-width: 0; min-height: 26px; padding: 0; border: 0; outline: none; background: transparent; color: var(--text-primary); }
.display-controls { flex-wrap: wrap; }
.level-filter { display: flex; padding: 1px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); }
.level-filter :deep(button) { padding-inline: 5px; font-size: 11px; }
.match-count, .copy-status { color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
</style>
