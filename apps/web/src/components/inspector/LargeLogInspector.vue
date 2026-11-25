<script setup lang="ts">
import type { Session } from '@mini-agent-run/shared';
import { computed } from 'vue';
import type { useLogInspector } from '../../composables/useLogInspector';
import { formatSliceAsJson } from '../../utils/logFormat';
import InspectorTargetPreview from '../layout/InspectorTargetPreview.vue';
import UiButton from '../ui/UiButton.vue';
import LogErrorIndex from './LogErrorIndex.vue';
import LogToolbar from './LogToolbar.vue';
import LogVirtualSliceList from './LogVirtualSliceList.vue';

const props = defineProps<{ session: Session; inspector: ReturnType<typeof useLogInspector> }>();
const {
  sourceMode, fileListError, fileListLoading, fileOptions, filePickerOpen, selectedFilePath,
  slice, loadedLines, loading, loadingMore, error, searchQuery, viewMode, evidenceTarget, focusRange,
  selectedLine, stepNotice, scrollRequest, errorRows, errorTotalCount, errorHasMore, errorLoading, errorFetchError,
  nextBodyOffset, canGoPrevious, jumpToLine, loadMoreErrors, retryErrors, retryFiles, retryBody, previousPage, nextPage, loadMore,
} = props.inspector;
const formatted = computed(() => formatSliceAsJson(slice.value?.lines ?? []));
const showEmptyDirectory = computed(() => sourceMode.value === 'file' && props.session.pathType === 'dir'
  && !fileOptions.value.length && !selectedFilePath.value && !fileListLoading.value && !fileListError.value);

function escapePicker(event: KeyboardEvent) {
  if (!filePickerOpen.value || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  filePickerOpen.value = false;
}
</script>

<template>
  <section class="log-inspector" data-testid="log-inspector-drawer" @keydown.esc="escapePicker">
    <LogToolbar :inspector="inspector" />
    <div v-if="evidenceTarget" class="evidence">
      <InspectorTargetPreview :target="evidenceTarget" :target-path="session.targetPath" />
      <p v-if="stepNotice" role="status" data-testid="log-step-notice">{{ stepNotice }}</p>
    </div>
    <div class="log-body">
      <div class="main-log">
        <div v-if="fileListLoading && !loading && !slice" class="notice" role="status">正在读取文件列表…</div>
        <div v-if="sourceMode === 'file' && fileListError" class="notice" role="alert">
          {{ fileListError }} <UiButton variant="ghost" size="sm" @click="retryFiles">重试</UiButton>
        </div>
        <p v-if="showEmptyDirectory" class="notice" role="status">目录中没有可检视的文件。</p>
        <p v-if="loading" class="notice" role="status">正在读取日志…</p>
        <div v-if="error" class="notice" role="alert" data-testid="log-slice-error">
          {{ error }} <UiButton variant="ghost" size="sm" @click="retryBody">重试</UiButton>
        </div>
        <p v-if="slice && !loadedLines.length" class="notice" role="status">{{ searchQuery ? '没有匹配的日志行。' : '当前切片没有日志行。' }}</p>
        <LogVirtualSliceList
          v-if="viewMode === 'raw'" :lines="loadedLines" :search-query="searchQuery" :focus-range="focusRange"
          :selected-line="selectedLine" :scroll-request="scrollRequest"
        />
        <template v-else>
          <p v-if="formatted.plainCount" class="notice format-note">保留 {{ formatted.plainCount }} 行普通文本</p>
          <pre class="json-view" data-testid="log-json-view" tabindex="0">{{ formatted.text }}</pre>
        </template>
      </div>
      <LogErrorIndex
        :rows="errorRows" :total="errorTotalCount" :loading="errorLoading" :has-more="errorHasMore"
        :error="errorFetchError" :selected-line="selectedLine" @jump="jumpToLine" @more="loadMoreErrors" @retry="retryErrors"
      />
    </div>
    <footer v-if="slice || canGoPrevious" class="pagination">
      <span v-if="slice" class="tabular-nums">
        {{ loadedLines[0]?.lineNumber ?? 0 }}–{{ loadedLines.at(-1)?.lineNumber ?? 0 }} / {{ slice.totalLines }} 行
      </span>
      <UiButton variant="ghost" size="sm" data-testid="log-prev-page" :disabled="!canGoPrevious || loading || loadingMore" @click="previousPage">上一页</UiButton>
      <UiButton variant="ghost" size="sm" data-testid="log-next-page" :disabled="nextBodyOffset === null || loading || loadingMore" @click="nextPage">下一页</UiButton>
      <UiButton
        v-if="nextBodyOffset !== null" variant="subtle" size="sm" data-testid="log-load-more"
        :disabled="loading || loadingMore" @click="loadMore"
      >{{ loadingMore ? '正在加载…' : '加载更多' }}</UiButton>
    </footer>
  </section>
</template>

<style scoped>
.log-inspector { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--bg-panel); }
.evidence { flex: none; padding: 5px 8px; border-bottom: 1px solid var(--border-subtle); }
.evidence :deep(.target-preview) { padding: 6px; gap: 3px; }
.evidence :deep(dl) { display: flex; flex-wrap: wrap; gap: 1px 9px; }
.evidence :deep(dl > div) { display: flex; min-width: 0; }
.evidence p { margin: 3px 0 0; color: var(--text-secondary); font: 11px/16px var(--font-mono); }
.log-body { display: grid; grid-template-columns: minmax(0, 1fr) clamp(112px, 30%, 205px); flex: 1; min-height: 0; background: var(--bg-base); }
.main-log { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.notice { flex: none; margin: 0; padding: 7px; color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.format-note { padding-block: 4px; }
.json-view { flex: 1; min-height: 0; margin: 0; padding: 7px; overflow: auto; color: var(--text-code); font: 12px/18px var(--font-mono); }
.pagination { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 3px; padding: 4px 6px; border-top: 1px solid var(--border-subtle); }
.pagination span { margin-inline-end: auto; color: var(--text-secondary); font-size: 11px; }
</style>
