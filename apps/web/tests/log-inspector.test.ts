// @vitest-environment happy-dom
import { MAX_ARTIFACT_SLICE_LINES, type FsBrowseEntry, type LogLine, type Session } from '@mini-agent-run/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import LargeLogInspector from '../src/components/inspector/LargeLogInspector.vue';
import { useLogInspector } from '../src/composables/useLogInspector';
import { artifact, health, run, session } from './fixtures';
import { closedRun, conclusion, frame } from './timeline-fixtures';

const single: Session = { ...session, id: 'ses_single', pathType: 'file', targetPath: '/safe/solo.log' };
const second: Session = { ...session, id: 'ses_next', targetPath: '/safe/next' };
const first = '/safe/a/first.json';
const original = '/safe/a/actual.JSONL';
const warnFile = '/safe/a/mixed.Log';
const plainFile = '/safe/a/notes.txt';
const rows = (lines: string[]): LogLine[] => lines.map((text, index) => ({
  lineNumber: index + 1, text, level: text.startsWith('ERROR') ? 'error' : text.startsWith('WARN') ? 'warn' : 'info',
}));
const listing: FsBrowseEntry[] = [
  { kind: 'file', name: 'first.json', path: first },
  { kind: 'file', name: 'visible.JSONL', path: original },
  { kind: 'file', name: 'mixed.Log', path: warnFile },
  { kind: 'file', name: 'notes.txt', path: plainFile },
  { kind: 'file', name: 'image.png', path: '/safe/a/image.png' },
  { kind: 'dir', name: 'subdir.log', path: '/safe/a/subdir.log' },
];
const test = (name: string) => '[data-testid="' + name + '"]';
const lineAttr = (line: number) => '[data-line-number="' + line + '"]';
const jumpAttr = (line: number) => '[data-error-line="' + line + '"]';
const wrappers: VueWrapper[] = [];

function large(count: number, overrides: Record<number, string> = {}, suffix = '') {
  return rows(Array.from({ length: count }, (_, index) => overrides[index + 1] ?? 'INFO context ' + (index + 1) + suffix));
}

function slice(lines: LogLine[], url: URL) {
  const params = url.searchParams;
  const offsetLine = Number(params.get('startLine') ?? params.get('offsetLine') ?? 1);
  const limit = Number(params.get('limit') ?? MAX_ARTIFACT_SLICE_LINES);
  const level = params.get('level');
  const keyword = params.get('q')?.toLowerCase();
  const matches = lines.filter((line) => (!level || line.level === level) && (!keyword || line.text.toLowerCase().includes(keyword)));
  const fromOffset = matches.filter((line) => line.lineNumber >= offsetLine);
  const nextOffsetLine = fromOffset[limit]?.lineNumber ?? null;
  return { totalLines: lines.length, matchedLines: matches.length, offsetLine, limit,
    hasMore: nextOffsetLine !== null, nextOffsetLine, lines: fromOffset.slice(0, limit) };
}

function problem(status: number, code: string) { return Response.json({ error: { code, message: 'Fixture error' } }, { status }); }
function urlPath(input: RequestInfo | URL) { return new URL(String(input), 'http://localhost'); }
function same(url: URL, path: string, query: Record<string, string | null> = {}) {
  return url.pathname === path && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === value);
}
const fileRoute = (s: Session) => '/api/sessions/' + s.id + '/file-slice';

function mockLogs({
  files = {}, dirs = { [session.targetPath]: listing }, artifactLines = [], other,
}: {
  files?: Record<string, LogLine[]>;
  dirs?: Record<string, FsBrowseEntry[]>;
  artifactLines?: LogLine[];
  other?: (url: URL) => Response | undefined;
} = {}) {
  const calls: URL[] = [];
  const holds = new Map<string, { promise: Promise<Response>; release: () => void }>();
  const catalog = {
    [first]: rows(['INFO first source', 'ERROR first actual']),
    [original]: rows(['INFO chosen source', 'ERROR selected actual']),
    [single.targetPath]: rows(['INFO only source']),
    ...files,
  };
  function answer(url: URL) {
    if (url.pathname === '/api/fs/browse') {
      const path = url.searchParams.get('path') ?? '';
      const entries = dirs[path];
      return entries ? Response.json({ currentPath: path, parentPath: '/safe', allowedRoots: ['/safe'], entries }) : problem(404, 'PATH_NOT_FOUND');
    }
    if (url.pathname === '/api/artifacts/' + artifact.id) return Response.json({ artifact, slice: slice(artifactLines, url) });
    const file = url.searchParams.get('file') ?? (url.pathname === fileRoute(single) ? single.targetPath : null);
    if (url.pathname.endsWith('/file-slice') && file) return Response.json(slice(catalog[file] ?? rows(['INFO fixture ' + file]), url));
    return other?.(url) ?? problem(404, 'NOT_FOUND');
  }
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = urlPath(input);
    calls.push(url);
    return holds.get(url.pathname + url.search)?.promise ?? answer(url);
  });
  vi.stubGlobal('fetch', fetchImpl);
  return {
    calls, fetchImpl,
    see(path: string, query?: Record<string, string | null>) { return calls.some((url) => same(url, path, query)); },
    hold(pathAndQuery: string) {
      let send!: (value: Response) => void;
      const promise = new Promise<Response>((resolve) => { send = resolve; });
      const release = () => {
        holds.delete(pathAndQuery);
        send(answer(urlPath(pathAndQuery)));
      };
      holds.set(pathAndQuery, { promise, release });
      return release;
    },
  };
}

async function inspectorFor(initial: Session) {
  const sessionRef = ref<Session | null>(initial);
  const open = ref(true);
  let inspector!: ReturnType<typeof useLogInspector>;
  const wrapper = mount(defineComponent({
    setup() {
      inspector = useLogInspector({ session: sessionRef, open });
      return () => sessionRef.value && open.value ? h(LargeLogInspector, { session: sessionRef.value, inspector }) : null;
    },
  }), { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  return {
    wrapper, sessionRef, inspector,
    el: (id: string) => wrapper.get(test(id)),
    line: (number: number) => wrapper.get(test('log-line') + lineAttr(number)),
    errorAt: (number: number) => wrapper.get(test('log-error-jump') + jumpAttr(number)),
  };
}

async function click(wrapper: VueWrapper, id: string) {
  await wrapper.get(test(id)).trigger('click');
  await flushPromises();
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('F11_LARGE_LOG_INSPECTOR_UI · 右栏检视器', () => {
  it('W3-02 绑定文件无 file 参数，目录按真实路径选择并记忆，显示空目录和失败', async () => {
    const api = mockLogs({ dirs: { [session.targetPath]: listing, [second.targetPath]: [] } });
    const ui = await inspectorFor(single);
    expect(api.see(fileRoute(single), { file: null, startLine: '1', limit: '200', level: null })).toBe(true);
    expect(ui.line(1).text()).toContain('INFO only source');
    await click(ui.wrapper, 'log-file-choose');
    expect(ui.wrapper.findAll(test('log-file-option')).map((entry) => entry.attributes('data-file-path'))).toEqual([single.targetPath]);
    ui.sessionRef.value = session;
    await flushPromises();
    expect(api.see('/api/fs/browse', { path: session.targetPath })).toBe(true);
    expect(ui.line(1).text()).toContain('first source');
    await click(ui.wrapper, 'log-file-choose');
    const entries = ui.wrapper.findAll(test('log-file-option'));
    expect(entries.map((entry) => entry.text())).toEqual(listing.slice(0, 4).map(({ name }) => name));
    await entries[1]!.trigger('click');
    await flushPromises();
    expect(api.see(fileRoute(session), { file: original, level: null })).toBe(true);
    expect(ui.line(1).text()).toContain('chosen source');
    ui.sessionRef.value = second;
    await flushPromises();
    expect(ui.wrapper.text()).toContain('目录中没有可检视的文件');
    ui.sessionRef.value = { ...second, id: 'ses_missing', targetPath: '/safe/missing' };
    await flushPromises();
    expect(ui.wrapper.get('[role="alert"]').text()).toContain('不存在');
    ui.sessionRef.value = session;
    await flushPromises();
    expect(ui.line(1).text()).toContain('chosen source');
  });

  it('W3-02 相对路径证据保留目录选择，切回后正文与错误索引仍读原文件', async () => {
    const logName = 'noisy-large-xss.log';
    const logPath = session.targetPath + '/' + logName;
    const log = large(140, { 115: 'ERROR evidence from selected log' });
    const api = mockLogs({
      dirs: { [session.targetPath]: [listing[0]!, { kind: 'file', name: logName, path: logPath }] },
      files: { [logPath]: log, [logName]: log },
    });
    const ui = await inspectorFor(session);
    const pickerSelection = async () => {
      await click(ui.wrapper, 'log-file-choose');
      const selected = ui.wrapper.findAll(test('log-file-option') + '[aria-pressed="true"]')
        .map((option) => option.attributes('data-file-path'));
      await click(ui.wrapper, 'log-file-choose');
      return selected;
    };
    await click(ui.wrapper, 'log-file-choose');
    await ui.wrapper.get(test('log-file-option') + '[data-file-path="' + logPath + '"]').trigger('click');
    await flushPromises();
    ui.inspector.openTarget({ mode: 'file', sessionId: session.id, file: logName, line: 115, label: '相对路径证据' });
    await flushPromises();
    expect(ui.line(115).attributes('data-highlighted')).toBe('true');
    const duringEvidence = await pickerSelection();

    ui.sessionRef.value = single;
    await flushPromises();
    const beforeReturn = api.calls.length;
    ui.sessionRef.value = session;
    await flushPromises();
    const afterReturn = await pickerSelection();
    const reads = api.calls.slice(beforeReturn)
      .filter((url) => same(url, fileRoute(session)))
      .map((url) => [url.searchParams.get('file'), url.searchParams.get('level')]);
    expect({ duringEvidence, afterReturn, reads }).toEqual({
      duringEvidence: [logPath], afterReturn: [logPath], reads: [[logPath, null], [logPath, 'error']],
    });
    expect(ui.line(1).get(test('log-line-text')).text()).toBe(log[0]?.text);
    expect(ui.errorAt(115).text()).toContain('evidence from selected log');
  });

  it('W3-03 文件弹层 Escape 归还焦点，丢弃迟到文件列表、正文与索引', async () => {
    const incoming = '/safe/next/new.log';
    const api = mockLogs({ dirs: { [session.targetPath]: listing, [second.targetPath]: [{ kind: 'file', name: 'new.log', path: incoming }] } });
    const lateList = api.hold('/api/fs/browse?path=%2Fsafe%2Fa');
    const ui = await inspectorFor(session);
    ui.sessionRef.value = second;
    await flushPromises();
    lateList();
    await flushPromises();
    await click(ui.wrapper, 'log-file-choose');
    expect(ui.wrapper.findAll(test('log-file-option')).map((option) => option.text())).toEqual(['new.log']);
    ui.wrapper.get<HTMLElement>(test('log-file-option')).element.focus();
    await ui.el('log-file-option').trigger('keydown', { key: 'Escape' });
    await nextTick();
    expect(ui.el('log-file-choose').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(ui.el('log-file-choose').element);
    expect(ui.wrapper.find(test('log-inspector-drawer')).exists()).toBe(true);

    ui.sessionRef.value = session;
    await flushPromises();
    const bodyQuery = fileRoute(session) + '?startLine=1&file=%2Fsafe%2Fa%2Factual.JSONL&limit=200';
    const oldBody = api.hold(bodyQuery);
    const oldErrors = api.hold(bodyQuery + '&level=error');
    await click(ui.wrapper, 'log-file-choose');
    await ui.wrapper.get(test('log-file-option') + '[data-file-path="' + original + '"]').trigger('click');
    await flushPromises();
    expect(api.see(fileRoute(session), { file: original, level: 'error' })).toBe(true);
    await click(ui.wrapper, 'log-file-choose');
    await ui.wrapper.get(test('log-file-option') + '[data-file-path="' + first + '"]').trigger('click');
    await flushPromises();
    oldErrors();
    oldBody();
    await flushPromises();
    expect(ui.line(1).text()).toContain('first source');
    expect(ui.errorAt(2).text()).toContain('first actual');
    expect(ui.wrapper.text()).not.toContain('selected actual');
  });

  it('W3-04 Artifact 按证据单独请求并可返回前一个原文件及错误索引', async () => {
    const api = mockLogs({ artifactLines: large(260, { 219: 'ERROR artifact marker' }) });
    const ui = await inspectorFor(session);
    ui.inspector.chooseFile(original);
    await flushPromises();
    expect(api.calls.some((url) => url.pathname.startsWith('/api/artifacts/'))).toBe(false);
    ui.inspector.openTarget({ mode: 'artifact', artifactId: artifact.id, line: 219, endLine: 220, label: '保留证据' });
    await flushPromises();
    expect(api.see('/api/artifacts/' + artifact.id, { offsetLine: '179', level: null })).toBe(true);
    expect(ui.el('log-source-type').text()).toBe('Artifact');
    expect(ui.line(219).attributes('data-selected')).toBe('true');
    expect(ui.line(220).attributes('data-highlighted')).toBe('true');
    expect(ui.errorAt(219).text()).toContain('artifact marker');
    await click(ui.wrapper, 'return-to-original-file');
    expect(ui.el('log-source-type').text()).toBe('原文件');
    expect(ui.line(1).text()).toContain('chosen source');
    expect(ui.errorAt(2).text()).toContain('selected actual');
    expect(ui.wrapper.find(test('inspector-target-preview')).exists()).toBe(false);
  });

  it('W3-05 连续上下文、独立错误分页与 L1420 跨页定位', async () => {
    const logs = large(1600, {
      ...Object.fromEntries(Array.from({ length: 203 }, (_, i) => [i + 21, 'ERROR fixture ' + i])),
      1420: 'ERROR far context',
    });
    const api = mockLogs({ files: { [single.targetPath]: logs } });
    const ui = await inspectorFor(single);
    expect([1, 20, 21, 200].map((number) => ui.line(number).attributes('data-level'))).toEqual(['info', 'info', 'error', 'error']);
    expect(ui.el('log-error-count').text()).toBe('204');
    const indexCalls = api.calls.filter((url) => url.searchParams.get('level') === 'error').length;
    await click(ui.wrapper, 'log-next-page');
    expect(ui.wrapper.find(test('log-line') + lineAttr(201)).exists()).toBe(true);
    await click(ui.wrapper, 'log-prev-page');
    expect(ui.wrapper.find(test('log-line') + lineAttr(1)).exists()).toBe(true);
    expect(api.calls.filter((url) => url.searchParams.get('level') === 'error')).toHaveLength(indexCalls);
    await click(ui.wrapper, 'log-load-more-errors');
    expect(api.see(fileRoute(single), { level: 'error', startLine: '221' })).toBe(true);
    expect(ui.wrapper.findAll(test('log-error-jump'))).toHaveLength(204);
    await ui.errorAt(1420).trigger('click');
    await flushPromises();
    expect(api.see(fileRoute(single), { startLine: '1380', q: null, level: null })).toBe(true);
    expect(ui.line(1419).text()).toContain('INFO context 1419');
    expect(ui.line(1420).attributes('data-selected')).toBe('true');
    expect(ui.line(1421).text()).toContain('INFO context 1421');
    expect(ui.errorAt(1420).attributes('aria-current')).toBe('location');
  });

  it('W3-06 错误跳转恢复原文与 ALL，再回到证据范围', async () => {
    mockLogs({ files: { [single.targetPath]: large(960, { 800: 'ERROR far context' }) } });
    const ui = await inspectorFor(single);
    ui.inspector.openTarget({ mode: 'file', sessionId: single.id, line: 45, endLine: 47, label: '起点' });
    await flushPromises();
    await ui.wrapper.get('[data-log-level="info"]').trigger('click');
    await flushPromises();
    await click(ui.wrapper, 'log-view-mode-toggle');
    expect(ui.wrapper.find(test('log-json-view')).exists()).toBe(true);
    await ui.errorAt(800).trigger('click');
    await flushPromises();
    expect(ui.wrapper.find(test('log-json-view')).exists()).toBe(false);
    expect(ui.wrapper.get('[data-log-level="all"]').attributes('aria-pressed')).toBe('true');
    expect(ui.line(800).attributes('data-highlighted')).toBe('true');
    await click(ui.wrapper, 'log-jump-evidence-btn');
    expect(ui.line(45).attributes('data-selected')).toBe('true');
    expect(ui.line(47).attributes('data-highlighted')).toBe('true');
    expect(ui.line(48).attributes('data-highlighted')).toBe('false');
  });

  it('W3-07 后端关键词检索、精确高亮、上下导航、清空恢复及逐行复制', async () => {
    const expected = rows(['INFO ordinary', 'INFO a[.*]  ', 'WARN another', 'INFO last [.*]']);
    const api = mockLogs({ files: { [single.targetPath]: expected } });
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const ui = await inspectorFor(single);
    await ui.wrapper.get<HTMLInputElement>(test('log-search-input')).setValue('[.*]');
    await ui.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.see(fileRoute(single), { q: '[.*]', startLine: '1' })).toBe(true);
    expect(ui.el('log-match-count').text()).toContain('1 / 2');
    expect(ui.line(2).get('mark').text()).toBe('[.*]');
    expect(ui.line(2).get(test('log-line-text')).element.textContent).toBe(expected[1]!.text);
    await click(ui.wrapper, 'log-search-next');
    expect(ui.line(4).attributes('data-selected')).toBe('true');
    await click(ui.wrapper, 'log-search-prev');
    expect(ui.line(2).attributes('data-selected')).toBe('true');
    await click(ui.wrapper, 'log-copy-btn');
    expect(clipboard).toHaveBeenCalledWith('INFO a[.*]  \nINFO last [.*]');
    await ui.wrapper.get<HTMLInputElement>(test('log-search-input')).setValue('');
    await flushPromises();
    await click(ui.wrapper, 'log-copy-btn');
    expect(clipboard).toHaveBeenLastCalledWith(expected.map((entry) => entry.text).join('\n'));
    expect(ui.line(3).text()).toContain('WARN another');
    expect(ui.el('log-error-index').text()).toContain('当前来源无错误行');
  });

  it('W3-07 以全文件命中序号在 L200 与 L201 之间往返，追加后仍按命中游标翻页', async () => {
    const keyword = 'component=local-collector';
    const logs = rows(Array.from({ length: 2200 }, (_, index) =>
      index >= 205 && index < 214 ? 'INFO unmatched' : 'INFO ' + keyword));
    const matches = logs.filter(({ text }) => text.includes(keyword));
    const api = mockLogs({ files: { [single.targetPath]: logs } });
    const ui = await inspectorFor(single);
    const position = (line: number, ordinal: number) => {
      expect(ui.line(line).attributes('data-selected')).toBe('true');
      expect(ui.el('log-match-count').text()).toBe(ordinal + ' / 2191 命中');
    };
    await ui.wrapper.get<HTMLInputElement>(test('log-search-input')).setValue(keyword);
    await ui.wrapper.get('form').trigger('submit');
    await flushPromises();
    position(1, 1);
    await click(ui.wrapper, 'log-next-page');
    position(201, 201);
    await click(ui.wrapper, 'log-search-prev');
    position(200, 200);
    await click(ui.wrapper, 'log-search-next');
    position(201, 201);

    await click(ui.wrapper, 'log-load-more');
    await click(ui.wrapper, 'log-next-page');
    const fourthStart = matches[600]!.lineNumber;
    expect(api.see(fileRoute(single), { q: keyword, startLine: String(fourthStart) })).toBe(true);
    position(fourthStart, 601);
    await click(ui.wrapper, 'log-search-prev');
    position(matches[599]!.lineNumber, 600);
    await click(ui.wrapper, 'log-search-next');
    position(fourthStart, 601);
  });

  it('W3-08 多页累积 2480 行并以固定 24 px 虚拟窗口响应滚动', async () => {
    const log = large(2480, {}, ' ' + 'x'.repeat(152));
    expect(log.reduce((count, row) => count + row.text.length + 1, 0)).toBeGreaterThan(350_000);
    const api = mockLogs({ files: { [single.targetPath]: log } });
    const ui = await inspectorFor(single);
    let pages = 1;
    while (ui.wrapper.find(test('log-load-more')).exists() && pages <= 13) {
      await click(ui.wrapper, 'log-load-more');
      pages++;
    }
    expect(pages).toBe(13);
    expect(api.see(fileRoute(single), { startLine: '2401', limit: '200' })).toBe(true);
    const viewport = ui.wrapper.get<HTMLElement>(test('log-scroll-container'));
    expect(viewport.find('[data-content-height="59520"]').exists()).toBe(true);
    const lineCount = () => ui.wrapper.findAll(test('log-line')).length;
    expect(lineCount()).toBeLessThan(90);
    expect(ui.line(1).text()).toContain('INFO context 1');
    viewport.element.scrollTop = 30000;
    await viewport.trigger('scroll');
    expect(lineCount()).toBeGreaterThan(30);
    expect(lineCount()).toBeLessThan(90);
    expect(ui.wrapper.find(test('log-line') + lineAttr(1)).exists()).toBe(false);
    expect(ui.line(1251).text()).toContain('INFO context 1251');
    const geometry = Array.from(viewport.element.children).reduce(
      (total, item) => total + (item.hasAttribute('data-content-height') ? lineCount() * 24 : parseInt((item as HTMLElement).style.height, 10)), 0,
    );
    expect(geometry).toBe(2480 * 24);
  });

  it('W3-09 原文、高亮、JSON 与错误预览均保留恶意负载的文本语义', async () => {
    const html = '<script>window.__xss=1</script><img src=x onerror=alert(1)><iframe></iframe>';
    const jsonText = JSON.stringify({ payload: html });
    const hostile = 'ERROR  ' + html + '  ';
    mockLogs({ files: { [single.targetPath]: rows([hostile, jsonText]) } });
    const ui = await inspectorFor(single);
    expect(ui.line(1).get(test('log-line-text')).element.textContent).toBe(hostile);
    expect(ui.line(2).get(test('log-line-text')).element.textContent).toBe(jsonText);
    expect(ui.errorAt(1).get(test('log-error-preview')).element.textContent).toBe(hostile);
    expect(ui.wrapper.findAll('script,img,iframe')).toHaveLength(0);
    await ui.wrapper.get<HTMLInputElement>(test('log-search-input')).setValue('<SCRIPT>');
    await ui.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(ui.line(1).get('mark').element.textContent).toBe('<script>');
    expect(ui.line(1).get(test('log-line-text')).element.textContent).toBe(hostile);
    expect(ui.wrapper.findAll('script,img,iframe')).toHaveLength(0);
    await click(ui.wrapper, 'log-view-mode-toggle');
    expect(ui.el('log-json-view').element.textContent).toBe(hostile + '\n// 原始行 2\n' + JSON.stringify({ payload: html }, null, 2));
    expect(ui.wrapper.findAll('script,img,iframe')).toHaveLength(0);
  });

  it('W3-10 App 串联三类证据与工具入口，窄屏 Escape 优先关闭文件弹层', async () => {
    vi.stubGlobal('innerWidth', 1536);
    const record = { ...closedRun, lastSeq: 2, conclusion: {
      ...conclusion, evidence: [
        { kind: 'file_line' as const, file: original, startLine: 115, endLine: 117, label: '原始证据' },
        { kind: 'file_step' as const, file: original, step: 7, label: '步骤证据' },
        { kind: 'artifact_line' as const, artifactId: artifact.id, startLine: 219, label: '产物证据' },
      ],
    } };
    const api = mockLogs({
      files: { [original]: large(320, { 15: 'INFO step 70', 66: 'INFO step 7 complete' }) },
      artifactLines: large(240),
      other(url) {
        if (same(url, '/api/health')) return Response.json(health);
        if (same(url, '/api/sessions')) return Response.json({ sessions: [
          { ...session, hasActiveRun: false, runCount: 1 }, { ...single, hasActiveRun: false, runCount: 0 },
        ] });
        if (same(url, '/api/sessions/' + session.id)) return Response.json({ session, hasActiveRun: false, runs: [record] });
        if (same(url, '/api/sessions/' + single.id)) return Response.json({ session: single, hasActiveRun: false, runs: [] });
        if (!same(url, '/api/runs/' + run.id)) return;
        return Response.json({ run: record, events: [
          frame(1, { type: 'tool_execution_start', toolCallId: 'tc_proof', toolName: 'search_logs', step: 1, arguments: {} }),
          frame(2, { type: 'tool_execution_end', toolCallId: 'tc_proof', toolName: 'search_logs', step: 1,
            durationMs: 12, isError: false, preview: 'tool result', artifactId: artifact.id }),
        ] });
      },
    });
    const wrapper = mount(App, { attachTo: document.body, global: { stubs: { teleport: true } } });
    wrappers.push(wrapper);
    await flushPromises();
    const chip = (kind: string) => wrapper.get(test('evidence-chip') + '[data-evidence-kind="' + kind + '"]');
    const line = (number: number) => wrapper.get(test('log-line') + lineAttr(number));
    expect(wrapper.find('#inspector-panel').exists()).toBe(false);
    await chip('file_line').trigger('click');
    await flushPromises();
    expect(wrapper.get('#inspector-panel').element.tagName).toBe('ASIDE');
    expect(api.see(fileRoute(session), { file: original, startLine: '75' })).toBe(true);
    expect([115, 116, 117].map((n) => line(n).attributes('data-highlighted'))).toEqual(['true', 'true', 'true']);
    expect(line(118).attributes('data-highlighted')).toBe('false');
    expect(wrapper.get(test('inspector-target-preview')).text()).toContain('L115–L117');

    await chip('file_step').trigger('click');
    await flushPromises();
    expect(api.see(fileRoute(session), { q: '"step": 7' })).toBe(true);
    expect(api.see(fileRoute(session), { q: 'step 7' })).toBe(true);
    expect(api.see(fileRoute(session), { startLine: '26', q: null })).toBe(true);
    expect(line(66).attributes('data-selected')).toBe('true');
    expect(wrapper.get(test('log-step-notice')).text()).toBe('Step #7');
    await chip('artifact_line').trigger('click');
    await flushPromises();
    expect(api.see('/api/artifacts/' + artifact.id, { offsetLine: '179', level: null })).toBe(true);
    expect(line(219).attributes('data-selected')).toBe('true');
    await click(wrapper, 'return-to-original-file');
    expect(wrapper.get(test('log-source-type')).text()).toBe('原文件');
    expect(api.calls.at(-2)?.searchParams.get('file')).toBe(original);

    await click(wrapper, 'run-details-toggle');
    await click(wrapper, 'tool-toggle-btn');
    await click(wrapper, 'tool-inspect-btn');
    expect(wrapper.get(test('log-source-type')).text()).toBe('Artifact');
    expect(api.see('/api/artifacts/' + artifact.id, { offsetLine: '1', level: null })).toBe(true);
    await click(wrapper, 'return-to-original-file');
    vi.stubGlobal('innerWidth', 1140);
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(wrapper.get('#inspector-panel').attributes('role')).toBe('dialog');
    await click(wrapper, 'log-file-choose');
    await wrapper.get(test('log-file-option')).trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.findAll(test('log-file-option'))).toHaveLength(0);
    expect(document.activeElement).toBe(wrapper.get(test('log-file-choose')).element);
    expect(wrapper.find('#inspector-panel').exists()).toBe(true);
    await wrapper.get(test('log-file-choose')).trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.find('#inspector-panel').exists()).toBe(false);
  });
});
