import {
  MAX_ARTIFACT_SLICE_LINES, type ArtifactId, type ArtifactMeta, type FsBrowseEntry, type LogLevel, type LogLine,
  type Session, type SessionId, type TextSliceResponse,
} from '@mini-agent-run/shared';
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { ApiError, apiClient } from '../api/client';
import { formatPathError } from './usePathBrowser';
import type { InspectorTargetRequest } from './useRunStream';

export type LogLevelFilter = LogLevel | 'all';
export type LogViewMode = 'raw' | 'json';
export type LineRange = { startLine: number; endLine: number };
type Source =
  | { mode: 'file'; sessionId: SessionId; file?: string }
  | { mode: 'artifact'; sessionId: SessionId; artifactId: ArtifactId };
type InspectorClient = Pick<typeof apiClient, 'browseFs' | 'getSessionFileSlice' | 'getArtifactSlice'>;
type BodyPage = { offset: number; matchesBefore: number };
type PageNavigation = { previous: BodyPage[]; matchesBefore: number; selectLast?: boolean };

const supportedFile = /\.(jsonl?|log|txt)$/iu;
const pageSize = MAX_ARTIFACT_SLICE_LINES;
const contextStart = (line: number) => Math.max(1, line - 40);

function nextOffset(page: TextSliceResponse | null) {
  const offset = page?.nextOffsetLine;
  return page?.hasMore && offset != null && offset > page.offsetLine ? offset : null;
}

function orderedLines(previous: LogLine[], incoming: LogLine[]) {
  const byLine = new Map(previous.map((row) => [row.lineNumber, row]));
  for (const row of incoming) byLine.set(row.lineNumber, row);
  return [...byLine.values()].sort((first, second) => first.lineNumber - second.lineNumber);
}

function findListedFile(directory: string, entries: readonly FsBrowseEntry[], file: string) {
  const windows = /^(?:[a-z]:[\\/]|\\\\)/iu.test(directory);
  const key = (value: string) => windows ? value.replaceAll('\\', '/').toLowerCase() : value;
  const requested = key(file);
  const relative = requested.replace(/^(?:\.\/)+/u, '');
  const directChild = !relative.includes('/') && !/^[a-z]:/iu.test(relative);
  const root = key(directory).replace(/\/+$/u, '');
  return entries.find(({ path, name }) => key(path) === requested
    || (directChild && (key(path) === root + '/' + relative || key(name) === relative)));
}

function sliceIssue(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    if (error.status === 404) return '目标文件或 Artifact 已不存在。';
    if (error.status === 403) return '当前会话无法读取此目标。';
    if (error.status === 413) return '文件超过服务端允许的读取大小。';
    if (error.code === 'NETWORK_ERROR') return error.message;
  }
  return fallback;
}

export function useLogInspector({
  session, open, client = apiClient,
}: { session: Readonly<Ref<Session | null>>; open: Readonly<Ref<boolean>>; client?: InspectorClient }) {
  const sourceMode = ref<Source['mode']>('file');
  const fileOptions = shallowRef<FsBrowseEntry[]>([]);
  const filePickerOpen = ref(false);
  const fileListLoading = ref(false);
  const fileListError = ref('');
  const selectedFilePath = ref<string | null>(null);
  const remembered = new Map<SessionId, string>();
  const activeArtifactId = ref<ArtifactId | null>(null);
  const activeArtifactMeta = shallowRef<ArtifactMeta | null>(null);
  const slice = shallowRef<TextSliceResponse | null>(null);
  const loadedLines = shallowRef<LogLine[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref('');
  const levelFilter = ref<LogLevelFilter>('all');
  const searchQuery = ref('');
  const viewMode = ref<LogViewMode>('raw');
  const evidenceTarget = shallowRef<InspectorTargetRequest | null>(null);
  const focusRange = shallowRef<LineRange | null>(null);
  const selectedLine = ref<number | null>(null);
  const stepNotice = ref<string | null>(null);
  const scrollRequest = ref(0);
  const errorRows = shallowRef<LogLine[]>([]);
  const errorTotalCount = ref(0);
  const errorNextOffsetLine = ref<number | null>(null);
  const errorHasMore = computed(() => errorNextOffsetLine.value !== null);
  const errorLoading = ref(false);
  const errorFetchError = ref('');
  const displayedPages = shallowRef<BodyPage[]>([]);
  const previousPages = shallowRef<BodyPage[]>([]);
  const bodyStart = computed(() => displayedPages.value[0]?.offset ?? 1);
  const matchesBeforeWindow = computed(() => displayedPages.value[0]?.matchesBefore ?? 0);
  const matchInWindow = computed(() => loadedLines.value.findIndex((row) => row.lineNumber === selectedLine.value));
  const activeMatchIndex = computed(() => searchQuery.value && matchInWindow.value >= 0
    ? matchesBeforeWindow.value + matchInWindow.value : -1);
  const nextBodyOffset = computed(() => nextOffset(slice.value));
  const canGoPrevious = computed(() => previousPages.value.length > 0 || bodyStart.value > 1);
  let filesReady = false;
  let filesToken = 0;
  let sliceToken = 0;
  let errorsToken = 0;
  let bodyRetry: (() => Promise<boolean>) | undefined;

  function source(): Source | null {
    const current = session.value;
    if (!open.value || !current) return null;
    if (sourceMode.value === 'artifact') {
      return activeArtifactId.value ? { mode: 'artifact', sessionId: current.id, artifactId: activeArtifactId.value } : null;
    }
    if (current.pathType === 'file') return { mode: 'file', sessionId: current.id };
    return selectedFilePath.value ? { mode: 'file', sessionId: current.id, file: selectedFilePath.value } : null;
  }

  function selectedKey() { return JSON.stringify(source()); }

  async function read(current: Source, start: number, filters: { level?: LogLevel; q?: string } = {}) {
    const params = { limit: pageSize, ...filters };
    if (current.mode === 'file') {
      return { slice: await client.getSessionFileSlice(current.sessionId, { startLine: start, file: current.file, ...params }), artifact: null };
    }
    const result = await client.getArtifactSlice(current.artifactId, { offsetLine: start, ...params });
    if (result.artifact.id !== current.artifactId || result.artifact.sessionId !== current.sessionId) {
      throw new Error('Artifact identity mismatch.');
    }
    return result;
  }

  function selectLine(line: number) {
    selectedLine.value = line;
    scrollRequest.value++;
  }

  async function resolveStep(current: Source, step: number, accept: () => boolean) {
    const patterns = [
      { q: '"step": ' + step, exact: new RegExp('"step"\\s*:\\s*' + step + '(?![\\d.])', 'iu') },
      { q: 'step ' + step, exact: new RegExp('\\bstep\\s+' + step + '(?![\\d.])', 'iu') },
    ];
    for (const { q, exact } of patterns) {
      try {
        const result = await read(current, 1, { q });
        if (!accept()) return;
        const first = result.slice.lines.find(({ text }) => exact.test(text));
        if (first) return first.lineNumber;
      } catch {
        if (!accept()) return;
      }
    }
  }

  type PageRequest = { append?: boolean; line?: number; step?: number; navigation?: PageNavigation };
  async function loadBody(offset: number, { append = false, line, step, navigation }: PageRequest = {}) {
    const current = source();
    if (!current) return false;
    const requestOffset = offset;
    const key = selectedKey();
    const token = ++sliceToken;
    const accept = () => token === sliceToken && key === selectedKey();
    loading.value = !append;
    loadingMore.value = append;
    error.value = '';
    bodyRetry = undefined;
    if (!append) {
      loadedLines.value = [];
      slice.value = null;
      selectedLine.value = null;
      scrollRequest.value++;
    }
    const query = searchQuery.value;
    const level = levelFilter.value === 'all' ? undefined : levelFilter.value;
    try {
      let target = line;
      if (step !== undefined) {
        target = await resolveStep(current, step, accept);
        if (!accept()) return false;
        if (target !== undefined) {
          focusRange.value = { startLine: target, endLine: target };
          offset = contextStart(target);
        }
      }
      const result = await read(current, offset, { level, q: query || undefined });
      if (!accept()) return false;
      activeArtifactMeta.value = result.artifact;
      slice.value = result.slice;
      const previousLines = append ? loadedLines.value : [];
      // Slice offsets are physical line numbers. Count accepted matches to determine the global ordinal.
      const page = {
        offset: result.slice.offsetLine,
        matchesBefore: append ? matchesBeforeWindow.value + previousLines.length : navigation?.matchesBefore ?? 0,
      };
      displayedPages.value = append ? [...displayedPages.value, page] : [page];
      if (navigation) previousPages.value = navigation.previous;
      loadedLines.value = orderedLines(previousLines, result.slice.lines);
      const match = query && !append ? loadedLines.value.at(navigation?.selectLast ? -1 : 0) : undefined;
      const selected = target ?? match?.lineNumber;
      if (selected !== undefined && loadedLines.value.some(({ lineNumber }) => lineNumber === selected)) selectLine(selected);
      return true;
    } catch (issue) {
      if (accept()) {
        error.value = sliceIssue(issue, '无法读取日志切片，请重试。');
        bodyRetry = () => loadBody(requestOffset, { append, line, step, navigation });
      }
      return false;
    } finally {
      if (accept()) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  async function loadErrors(append = false) {
    const current = source();
    const offset = append ? errorNextOffsetLine.value : 1;
    if (!current || offset === null || (append && errorLoading.value)) return;
    const key = selectedKey();
    const token = ++errorsToken;
    const accept = () => token === errorsToken && key === selectedKey();
    errorLoading.value = true;
    errorFetchError.value = '';
    try {
      const { slice: page } = await read(current, offset, { level: 'error' });
      if (!accept()) return;
      errorRows.value = orderedLines(append ? errorRows.value : [], page.lines);
      errorTotalCount.value = page.matchedLines;
      errorNextOffsetLine.value = nextOffset(page);
    } catch (issue) {
      if (accept()) errorFetchError.value = sliceIssue(issue, '无法读取错误索引，请重试。');
    } finally {
      if (accept()) errorLoading.value = false;
    }
  }

  function clearRequests() {
    filesToken++;
    sliceToken++;
    errorsToken++;
    fileListLoading.value = false;
    loading.value = false;
    loadingMore.value = false;
    errorLoading.value = false;
    bodyRetry = undefined;
  }

  function clearPage() {
    slice.value = null;
    loadedLines.value = [];
    error.value = '';
    errorRows.value = [];
    errorTotalCount.value = 0;
    errorNextOffsetLine.value = null;
    errorFetchError.value = '';
    selectedLine.value = null;
    previousPages.value = [];
    displayedPages.value = [];
    scrollRequest.value++;
  }

  function rememberFile(id: SessionId, path: string | null) {
    selectedFilePath.value = path;
    if (path === null) remembered.delete(id);
    else remembered.set(id, path);
  }

  function selectEvidenceFile(current: Session, file: string) {
    const listed = findListedFile(current.targetPath, fileOptions.value, file);
    if (listed) rememberFile(current.id, listed.path);
    // Keep off-list evidence usable without replacing the remembered directory selection.
    else selectedFilePath.value = file;
  }

  function loadSource() {
    const target = evidenceTarget.value;
    const line = focusRange.value?.startLine;
    const step = target?.mode === 'file' && target.line === undefined ? target.step : undefined;
    void loadBody(line === undefined ? 1 : contextStart(line), { line, step });
    void loadErrors();
  }

  async function browse() {
    const current = session.value;
    if (!open.value || current?.pathType !== 'dir' || sourceMode.value !== 'file') return;
    const key = selectedKey();
    const token = ++filesToken;
    const accept = () => token === filesToken && open.value && session.value?.id === current.id
      && session.value.targetPath === current.targetPath && key === selectedKey();
    fileListLoading.value = true;
    fileListError.value = '';
    try {
      const result = await client.browseFs(current.targetPath);
      if (!accept()) return;
      const options = result.entries.filter(({ kind, path }) => kind === 'file' && supportedFile.test(path));
      fileOptions.value = options;
      filesReady = true;
      const evidenceFile = evidenceTarget.value?.mode === 'file' ? evidenceTarget.value.file : undefined;
      if (evidenceFile) {
        const previous = selectedFilePath.value;
        selectEvidenceFile(current, evidenceFile);
        if (selectedFilePath.value !== previous) activateSource();
        return;
      }
      const path = options.find(({ path }) => path === selectedFilePath.value)?.path ?? options[0]?.path ?? null;
      fileListLoading.value = false;
      rememberFile(current.id, path);
      if (path) loadSource();
    } catch (issue) {
      if (accept()) fileListError.value = formatPathError(issue).message;
    } finally {
      if (token === filesToken) fileListLoading.value = false;
    }
  }

  function activateSource() {
    clearRequests();
    clearPage();
    const current = session.value;
    if (!open.value || !current) return;
    if (sourceMode.value === 'artifact') {
      loadSource();
      return;
    }
    if (current.pathType === 'file') {
      const name = current.targetPath.split(/[\\/]/u).at(-1) || current.targetPath;
      fileOptions.value = [{ name, path: current.targetPath, kind: 'file' }];
      selectedFilePath.value = current.targetPath;
      loadSource();
      return;
    }
    const evidenceFile = evidenceTarget.value?.mode === 'file' ? evidenceTarget.value.file : undefined;
    if (evidenceFile || filesReady) {
      if (source()) loadSource();
    }
    if (!filesReady) void browse();
  }

  function clearTarget() {
    evidenceTarget.value = null;
    focusRange.value = null;
    stepNotice.value = null;
  }

  function resetFilters() {
    searchQuery.value = '';
    levelFilter.value = 'all';
    viewMode.value = 'raw';
  }

  watch([open, () => session.value?.id, () => session.value?.targetPath], ([, id, path], old) => {
    if (id !== old?.[1] || path !== old?.[2]) {
      fileOptions.value = [];
      fileListError.value = '';
      filesReady = false;
      selectedFilePath.value = id ? remembered.get(id) ?? null : null;
      sourceMode.value = 'file';
      activeArtifactId.value = null;
      activeArtifactMeta.value = null;
      clearTarget();
      resetFilters();
    }
    filePickerOpen.value = false;
    activateSource();
  }, { immediate: true, flush: 'sync' });

  onScopeDispose(clearRequests);

  function openTarget(target: InspectorTargetRequest) {
    const current = session.value;
    if (!current || (target.mode === 'file' && target.sessionId !== current.id)) return;
    filePickerOpen.value = false;
    evidenceTarget.value = target;
    resetFilters();
    sourceMode.value = target.mode;
    activeArtifactId.value = target.mode === 'artifact' ? target.artifactId : null;
    activeArtifactMeta.value = null;
    focusRange.value = target.line === undefined ? null : {
      startLine: target.line, endLine: Math.max(target.line, target.endLine ?? target.line),
    };
    stepNotice.value = target.mode === 'file' && target.line === undefined && target.step !== undefined
      ? 'Step #' + target.step : null;
    if (target.mode === 'file' && current.pathType === 'dir' && target.file) selectEvidenceFile(current, target.file);
    if (open.value) activateSource();
  }

  function returnToOriginalFile() {
    sourceMode.value = 'file';
    activeArtifactId.value = null;
    activeArtifactMeta.value = null;
    clearTarget();
    resetFilters();
    activateSource();
  }

  function chooseFile(path: string) {
    const current = session.value;
    if (!current || sourceMode.value !== 'file' || !fileOptions.value.some((entry) => entry.path === path)) return;
    filePickerOpen.value = false;
    if (selectedFilePath.value === path) return;
    rememberFile(current.id, path);
    clearTarget();
    resetFilters();
    activateSource();
  }

  async function jumpToLine(line: number) {
    const visible = loadedLines.value.some(({ lineNumber }) => lineNumber === line);
    viewMode.value = 'raw';
    if (visible && !searchQuery.value) { selectLine(line); return; }
    searchQuery.value = '';
    levelFilter.value = 'all';
    previousPages.value = [];
    await loadBody(contextStart(line), { line });
  }

  function changeQuery(query: string) {
    const normalized = query.trim();
    if (searchQuery.value === normalized) return;
    searchQuery.value = normalized;
    previousPages.value = [];
    void loadBody(1);
  }

  function changeLevel(level: LogLevelFilter) {
    if (levelFilter.value === level) return;
    levelFilter.value = level;
    previousPages.value = [];
    void loadBody(1);
  }

  function nextPage() {
    const offset = nextBodyOffset.value;
    if (offset === null || loading.value || loadingMore.value) return;
    const searching = searchQuery.value !== '';
    const current = searching ? displayedPages.value : displayedPages.value.slice(0, 1);
    return loadBody(offset, { navigation: {
      previous: [...previousPages.value, ...current],
      matchesBefore: searching ? matchesBeforeWindow.value + loadedLines.value.length : 0,
    } });
  }

  function goPrevious(selectLast = false) {
    if (!canGoPrevious.value || loading.value || loadingMore.value) return;
    const page = previousPages.value.at(-1) ?? { offset: Math.max(1, bodyStart.value - pageSize), matchesBefore: 0 };
    return loadBody(page.offset, { navigation: {
      previous: previousPages.value.slice(0, -1), matchesBefore: page.matchesBefore, selectLast,
    } });
  }

  function previousPage() { return goPrevious(); }

  function loadMore() {
    const offset = nextBodyOffset.value;
    if (offset === null || loading.value || loadingMore.value) return Promise.resolve(false);
    return loadBody(offset, { append: true });
  }

  async function navigateMatch(delta: -1 | 1) {
    const count = loadedLines.value.length;
    if (!searchQuery.value || !count || loading.value || loadingMore.value) return;
    viewMode.value = 'raw';
    const index = matchInWindow.value < 0 ? (delta === 1 ? 0 : count - 1) : matchInWindow.value + delta;
    if (index < 0 && previousPages.value.length) { await goPrevious(true); return; }
    if (index >= count && nextBodyOffset.value !== null) { await nextPage(); return; }
    const allMatchesLoaded = previousPages.value.length === 0 && nextBodyOffset.value === null;
    const match = loadedLines.value[allMatchesLoaded ? (index + count) % count : index];
    if (match) selectLine(match.lineNumber);
  }

  return {
    sourceMode, fileOptions, filePickerOpen, fileListLoading, fileListError, selectedFilePath, activeArtifactId, activeArtifactMeta,
    slice, loadedLines, loading, loadingMore, error, levelFilter, searchQuery, activeMatchIndex, viewMode,
    evidenceTarget, focusRange, selectedLine, stepNotice, scrollRequest, errorRows, errorTotalCount,
    errorNextOffsetLine, errorHasMore, errorLoading, errorFetchError, nextBodyOffset, canGoPrevious,
    openTarget, returnToOriginalFile, chooseFile, jumpToLine, changeQuery, changeLevel, nextPage, previousPage, loadMore, navigateMatch,
    retryFiles: browse, retryBody: () => bodyRetry?.(),
    retryErrors: () => loadErrors(errorRows.value.length > 0), loadMoreErrors: () => loadErrors(true),
  };
}
