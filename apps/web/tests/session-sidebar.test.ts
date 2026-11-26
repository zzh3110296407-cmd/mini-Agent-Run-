// @vitest-environment happy-dom
import { COMPUTER_ROOT_PATH, CreateSessionRequestSchema, UpdateSessionRequestSchema,
  type FsBrowseResponse, type SessionListItem } from '@mini-agent-run/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import { apiClient } from '../src/api/client';
import { browse, health, run, session } from './fixtures';

const first: SessionListItem = { ...session, title: 'Alpha 排查', hasActiveRun: false, runCount: 2 };
const second: SessionListItem = {
  ...session, id: 'ses_second', title: 'Beta 排查', targetPath: 'D:\\safe\\second.log',
  pathType: 'file', hasActiveRun: true, runCount: 1,
};
const folder = '/safe/real/sub_dir';
const actualFile = folder + '/events record.jsonl';
const child: FsBrowseResponse = {
  ...browse, currentPath: folder, parentPath: '/safe',
  entries: [{ name: 'display-file', path: actualFile, kind: 'file' }],
};
const wrappers: VueWrapper[] = [];
const byTest = (id: string) => '[data-testid="' + id + '"]';

function problem(status: number, code: string) {
  return Response.json({ error: { code, message: 'fixture error' } }, { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const result = new Promise<T>((done) => { resolve = done; });
  return { result, resolve };
}

type Options = {
  sessions?: SessionListItem[];
  width?: number;
  browseAt?: (path: string | undefined) => FsBrowseResponse | Response | Promise<FsBrowseResponse | Response>;
  healthAt?: () => Response;
  detailAt?: (item: SessionListItem) => Response | Promise<Response>;
};

async function setup({ sessions = [first, second], width = 1440, browseAt, healthAt, detailAt }: Options = {}) {
  let rows = [...sessions];
  let newCount = 0;
  const api = { conflict: false };
  const fetchImpl = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/health') return healthAt ? healthAt() : Response.json(health);
    if (url.pathname === '/api/fs/browse') {
      const path = url.searchParams.get('path') ?? undefined;
      const result = browseAt ? await browseAt(path) : path === folder ? child : browse;
      return result instanceof Response ? result : Response.json(result);
    }
    if (url.pathname === '/api/sessions') {
      if (method === 'POST') {
        const { targetPath, title } = CreateSessionRequestSchema.parse(JSON.parse(String(init?.body)));
        const created: SessionListItem = {
          ...session, id: 'ses_new_' + ++newCount, title: title ?? '新会话 ' + newCount,
          targetPath, pathType: /\.jsonl$/i.test(targetPath) ? 'file' : 'dir', runCount: 0, hasActiveRun: false,
        };
        rows = [created, ...rows];
        return Response.json(created, { status: 201 });
      }
      return Response.json({ sessions: rows });
    }
    if (url.pathname.endsWith('/runs') || url.pathname.endsWith('/retry')) return Response.json(run, { status: 201 });
    const id = url.pathname.split('/').at(-1);
    const item = rows.find((row) => row.id === id);
    if (!item) return problem(404, 'SESSION_NOT_FOUND');
    if (method === 'PATCH') {
      const { title } = UpdateSessionRequestSchema.parse(JSON.parse(String(init?.body)));
      const renamed = { ...item, title };
      rows = [renamed, ...rows.filter((row) => row.id !== item.id)];
      return Response.json(renamed);
    }
    if (method === 'DELETE') {
      if (api.conflict) return problem(409, 'SESSION_HAS_ACTIVE_RUN');
      rows = rows.filter((row) => row.id !== id);
      return Response.json({ id, deleted: true });
    }
    return detailAt ? detailAt(item) : Response.json({ session: item, runs: [], hasActiveRun: item.hasActiveRun });
  });
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('fetch', fetchImpl);

  async function render() {
    const wrapper = mount(App, { attachTo: document.body, global: { stubs: { teleport: true } } });
    wrappers.push(wrapper);
    await flushPromises();
    return wrapper;
  }
  return { wrapper: await render(), render, fetchImpl, api };
}

function unmountAll() {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
}

afterEach(() => {
  unmountAll();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function openPicker(wrapper: VueWrapper) {
  await wrapper.get(byTest('new-session-btn')).trigger('click');
  await flushPromises();
}

function resize(width: number) {
  vi.stubGlobal('innerWidth', width);
  window.dispatchEvent(new Event('resize'));
  return flushPromises();
}

function key(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return flushPromises();
}

function paste(input: HTMLInputElement, value: string) {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', value);
  input.select();
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  return flushPromises();
}

function sessionPosts(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  return fetchImpl.mock.calls
    .filter(([url, init]) => url === '/api/sessions' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)));
}

describe('F09_SESSION_SIDEBAR_UI 工作台浏览器交互', () => {
  it('W1-01 健康探针可重试，主题、视口、右栏拖动和按键联动', async () => {
    let check = 0;
    const { wrapper } = await setup({ healthAt: () => {
      check++;
      if (check === 1) throw new Error('network');
      if (check === 2) return Response.json({ status: 'unavailable', sqlite: 'error' }, { status: 503 });
      return Response.json(health);
    } });
    const status = wrapper.get(byTest('health-status-badge'));
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toBe('离线');
    await status.get('button').trigger('click');
    await flushPromises();
    expect(status.text()).toBe('离线');
    await status.get('button').trigger('click');
    await flushPromises();
    expect(status.text()).toBe('在线');
    await wrapper.get(byTest('toggle-theme-btn')).trigger('click');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('mini-agent-run.theme')).toBe('light');
    await wrapper.get(byTest('toggle-inspector-btn')).trigger('click');
    expect(wrapper.get(byTest('toggle-inspector-btn')).attributes('aria-expanded')).toBe('true');
    const divider = wrapper.get(byTest('inspector-divider'));
    await divider.trigger('keydown', { key: 'ArrowLeft' });
    expect(divider.attributes('aria-valuenow')).toBe('584');
    await divider.trigger('keydown', { key: 'ArrowRight' });
    expect(divider.attributes('aria-valuenow')).toBe('560');
    await divider.trigger('mousedown', { clientX: 700, button: 0 });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    await flushPromises();
    expect(divider.attributes('aria-valuemax')).toBe('936');
    expect(divider.attributes('aria-valuenow')).toBe('936');
    expect(localStorage.getItem('mini-agent-run.inspector-width')).toBe('936');
    await resize(1280);
    expect(divider.attributes('aria-valuenow')).toBe('776');
    expect(divider.attributes('aria-valuemax')).toBe('776');
    await resize(1920);
    expect(divider.attributes('aria-valuenow')).toBe('936');
    expect(divider.attributes('aria-valuemax')).toBe('1416');
    const fullscreen = () => wrapper.get(byTest('inspector-fullscreen-btn'));
    await fullscreen().trigger('click');
    expect(fullscreen().attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('#inspector-panel').classes()).toContain('inspector-fullscreen');
    expect(wrapper.find(byTest('inspector-divider')).exists()).toBe(false);
    await fullscreen().trigger('click');
    expect(fullscreen().attributes('aria-pressed')).toBe('false');
    expect(wrapper.get(byTest('inspector-divider')).attributes('aria-valuenow')).toBe('936');
    await resize(1100);
    expect(wrapper.get('#inspector-panel').attributes('role')).toBe('dialog');
    const tabletDivider = () => wrapper.get(byTest('inspector-divider'));
    expect(tabletDivider().attributes('aria-valuemax')).toBe('1052');
    await key(tabletDivider().element, 'ArrowLeft');
    expect(tabletDivider().attributes('aria-valuenow')).toBe('960');
    await tabletDivider().trigger('mousedown', { clientX: 400, button: 0 });
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    await flushPromises();
    expect(tabletDivider().attributes('aria-valuenow')).toBe('1052');
    expect(localStorage.getItem('mini-agent-run.inspector-width')).toBe('1052');
    await fullscreen().trigger('click');
    expect(fullscreen().attributes('aria-pressed')).toBe('true');
    expect(wrapper.find(byTest('inspector-divider')).exists()).toBe(false);
    await key(fullscreen().element, 'Escape');
    expect(fullscreen().attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('#inspector-panel').classes()).not.toContain('inspector-fullscreen');
    expect(wrapper.get(byTest('inspector-divider')).attributes('aria-valuenow')).toBe('1052');
    await key(window, 'Escape');
    expect(wrapper.find('#inspector-panel').exists()).toBe(false);
    await wrapper.get(byTest('toggle-inspector-btn')).trigger('click');
    await fullscreen().trigger('click');
    await wrapper.get('#inspector-panel').get('button[aria-label="关闭"]').trigger('click');
    expect(wrapper.find('#inspector-panel').exists()).toBe(false);
    await wrapper.get(byTest('toggle-inspector-btn')).trigger('click');
    expect(fullscreen().attributes('aria-pressed')).toBe('false');
    await key(window, 'Escape');
    await resize(850);
    expect(wrapper.find(byTest('new-session-btn')).exists()).toBe(false);
    await key(window, '/');
    expect(document.activeElement).toBe(wrapper.get(byTest('session-filter-input')).element);
    await openPicker(wrapper);
    await key(window, 'Escape');
    expect(wrapper.find(byTest('path-picker-modal')).exists()).toBe(false);
    expect(wrapper.get('#sidebar-pane').attributes('role')).toBe('dialog');
    await key(window, 'Escape');
    expect(wrapper.find('#sidebar-pane').exists()).toBe(false);
  });

  it('W1-03 保存、替换、清除 Key，打开时输入为空且仅运行请求携带该头', async () => {
    const { wrapper, fetchImpl } = await setup();
    const open = () => wrapper.get(byTest('open-settings-btn')).trigger('click');
    const dialog = () => wrapper.get(byTest('settings-modal'));
    const originalKey = 'local-override-key-001';
    const replacementKey = 'local-override-key-002';
    await apiClient.startRun(first.id, { prompt: '检查' });
    await apiClient.retryRun(run.id);
    await open();
    expect(dialog().get(byTest('api-key-status')).text()).toContain('未覆盖');
    const input = () => dialog().get<HTMLInputElement>(byTest('api-key-input'));
    const save = () => dialog().get<HTMLButtonElement>(byTest('save-api-key-btn'));
    expect(input().attributes('type')).toBe('password');
    expect(input().attributes('autocomplete')).toBe('off');
    expect(save().element.disabled).toBe(true);
    await input().setValue('  ' + originalKey + '  ');
    expect(save().element.disabled).toBe(false);
    await save().trigger('click');
    expect(localStorage.getItem('mini-agent-run.llm-api-key')).toBe(originalKey);
    await open();
    expect(input().element.value).toBe('');
    expect(dialog().text()).not.toContain(originalKey);
    expect(dialog().get(byTest('api-key-status')).text()).toContain('已配置自定义 API Key');
    await apiClient.startRun(first.id, { prompt: '检查' });
    await apiClient.retryRun(run.id);
    await input().setValue(replacementKey);
    await save().trigger('click');
    expect(localStorage.getItem('mini-agent-run.llm-api-key')).toBe(replacementKey);
    await apiClient.startRun(first.id, { prompt: '重新检查' });
    await open();
    expect(input().element.value).toBe('');
    await dialog().get(byTest('clear-api-key-btn')).trigger('click');
    expect(localStorage.getItem('mini-agent-run.llm-api-key')).toBeNull();
    expect(dialog().get(byTest('api-key-status')).text()).toContain('.env');
    await apiClient.retryRun(run.id);
    const requests = fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/runs') || String(url).endsWith('/retry'));
    expect(requests.map(([, init]) => new Headers(init?.headers).get('X-LLM-API-Key')))
      .toEqual([null, null, originalKey, originalKey, replacementKey, null]);
    expect(requests.every(([url]) => !String(url).includes(originalKey))).toBe(true);
  });

  it('W1-04 目录钻取与单文件选择按 entry.path 原样提交', async () => {
    const { wrapper, fetchImpl } = await setup({ sessions: [] });
    expect(wrapper.get('main').text()).toContain('新建排查会话');
    await openPicker(wrapper);
    const entry = () => wrapper.get(byTest('fs-entry-row'));
    expect(entry().text()).toContain('display-only');
    expect(entry().attributes('data-entry-path')).toBe(folder);
    await entry().trigger('click');
    await flushPromises();
    expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url), 'http://localhost').searchParams.get('path') === folder)).toBe(true);
    expect(entry().text()).toContain('display-file');
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    expect(wrapper.get('main').text()).toContain(folder);
    expect(wrapper.get(byTest('session-item')).attributes('data-active')).toBe('true');
    await openPicker(wrapper);
    await entry().trigger('click');
    await flushPromises();
    await entry().trigger('click');
    expect(entry().attributes('aria-pressed')).toBe('true');
    expect(wrapper.get<HTMLInputElement>(byTest('path-address-input')).element.value).toBe(actualFile);
    await entry().trigger('click');
    expect(entry().attributes('aria-pressed')).toBe('false');
    expect(wrapper.get<HTMLInputElement>(byTest('path-address-input')).element.value).toBe(folder);
    await entry().trigger('click');
    await wrapper.get(byTest('session-title-trigger')).trigger('click');
    await wrapper.get(byTest('session-title-input')).setValue('文件检查');
    await key(wrapper.get(byTest('session-title-input')).element, 'Enter');
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    const posts = fetchImpl.mock.calls.filter(([url, init]) => url === '/api/sessions' && init?.method === 'POST');
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { targetPath: folder }, { targetPath: actualFile, title: '文件检查' },
    ]);
    expect(wrapper.get('main').text()).toContain(actualFile);
  });

  it('W1-05 地址栏与键盘导航丢弃过期的成功及失败响应', async () => {
    let older = deferred<FsBrowseResponse | Response>();
    let latest = deferred<FsBrowseResponse | Response>();
    const { wrapper } = await setup({ browseAt: (path) => {
      if (path === folder) return child;
      if (path === '/other' || path === '/other/recent' || path === '/other/final') return latest.result;
      if (path === '/older') return older.result;
      return browse;
    } });
    await openPicker(wrapper);
    const parent = () => wrapper.get<HTMLButtonElement>(byTest('path-parent-btn'));
    expect(parent().element.disabled).toBe(true);
    const dialog = () => wrapper.get(byTest('path-picker-modal'));
    const link = () => wrapper.get(byTest('fs-entry-row'));
    const manual = () => wrapper.get<HTMLInputElement>(byTest('path-address-input'));
    await manual().setValue('/safe/pasted.log');
    await key(wrapper.get(byTest('path-picker-modal')).element, 'Backspace');
    expect(manual().element.value).toBe('/safe/pasted.log');
    await key(wrapper.get(byTest('path-picker-modal')).element, 'ArrowDown');
    expect(document.activeElement).toBe(link().element);
    await key(link().element, 'Enter');
    expect(link().attributes('data-entry-path')).toBe(actualFile);
    expect(parent().element.disabled).toBe(false);
    await key(link().element, 'ArrowUp');
    await key(link().element, 'Backspace');
    expect(link().attributes('data-entry-path')).toBe(folder);

    async function jump(path: string) {
      await manual().setValue(path);
      await key(manual().element, 'Enter');
    }
    await jump('/older');
    await jump('/other');
    latest.resolve({ ...browse, currentPath: '/other', entries: [] });
    await flushPromises();
    expect(manual().element.value).toBe('/other');
    older.resolve(problem(403, 'PATH_OUTSIDE_ALLOWED_ROOTS'));
    await flushPromises();
    expect(dialog().find(byTest('path-error-banner')).exists()).toBe(false);
    expect(manual().element.value).toBe('/other');
    older = deferred();
    latest = deferred();
    await jump('/older');
    await manual().setValue('/other/recent');
    older.resolve(browse);
    await flushPromises();
    expect(manual().element.value).toBe('/other/recent');
    await key(manual().element, 'Enter');
    latest.resolve({ ...browse, currentPath: '/other/recent' });
    await flushPromises();
    expect(manual().element.value).toBe('/other/recent');

    older = deferred();
    latest = deferred();
    const fresh = { name: 'fresh.log', path: '/other/final/fresh.log', kind: 'file' } as const;
    const stale = { name: 'stale.log', path: '/older/stale.log', kind: 'file' } as const;
    const visibleRows = () => dialog().findAll(byTest('fs-entry-row'))
      .map((row) => [row.text(), row.attributes('data-entry-path')]);
    async function returnDirectory(pending: typeof older, data: FsBrowseResponse) {
      const response = Response.json(data);
      const decoded = deferred<void>();
      const read = response.json.bind(response);
      vi.spyOn(response, 'json').mockImplementation(async () => {
        const body: unknown = await read();
        decoded.resolve();
        return body;
      });
      pending.resolve(response);
      await decoded.result;
      await flushPromises();
    }
    await jump('/older');
    await jump('/other/final');
    await returnDirectory(latest, { ...browse, currentPath: '/other/final', entries: [fresh] });
    expect(visibleRows()).toEqual([[fresh.name, fresh.path]]);
    await returnDirectory(older, { ...browse, currentPath: '/older', entries: [stale] });
    expect(manual().element.value).toBe('/other/final');
    expect(visibleRows()).toEqual([[fresh.name, fresh.path]]);
  });

  it('W1-06 按 403、404、503 和 400 区分路径错误，验证后原样提交手动路径', async () => {
    const checks = [
      [403, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'forbidden', '白名单'],
      [403, 'PATH_FORBIDDEN', 'forbidden', '敏感文件或目录'],
      [404, 'PATH_NOT_FOUND', 'not-found', '不存在'],
      [503, 'NO_ACCESSIBLE_ROOTS', 'unavailable', '未配置'],
      [400, 'INVALID_PATH', 'invalid', '无效'],
      [400, 'UNSUPPORTED_TRACE_FILE', 'invalid', '不支持该文件类型'],
    ] as const;
    const manual = 'D:\\scope\\轨迹 #2.jsonl';
    const { wrapper, fetchImpl } = await setup({ browseAt: (path) => {
      const match = checks.find(([, code]) => path === 'bad-' + code);
      if (path === manual) return { ...browse, selectedFile: manual };
      return match ? problem(match[0], match[1]) : browse;
    } });
    await openPicker(wrapper);
    const input = () => wrapper.get(byTest('path-address-input'));
    for (const [status, code, severity, message] of checks) {
      await input().setValue('bad-' + code);
      await key(input().element, 'Enter');
      const banner = wrapper.get(byTest('path-error-banner'));
      expect(banner.attributes('role')).toBe('alert');
      expect(banner.text()).toContain(String(status));
      expect(banner.text()).toContain(message);
      expect(banner.attributes('data-error-code')).toBe(code);
      expect(input().classes()).toContain('uiv-path-input--' + severity);
      expect(wrapper.get<HTMLButtonElement>(byTest('confirm-create-session-btn')).element.disabled).toBe(true);
    }
    await input().setValue('  ' + manual + '  ');
    await key(input().element, 'Enter');
    expect(sessionPosts(fetchImpl)).toEqual([]);
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    const post = fetchImpl.mock.calls.find(([url, init]) => url === '/api/sessions' && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ targetPath: manual });
    expect(wrapper.get('main').text()).toContain(manual);
  });

  it('U1-04/05 只在顶栏编辑标题，Escape 恢复焦点，空白和默认标题使用自动命名', async () => {
    const { wrapper, fetchImpl } = await setup({ sessions: [] });
    await openPicker(wrapper);
    const dialog = () => wrapper.get(byTest('path-picker-modal'));
    const trigger = () => dialog().get<HTMLButtonElement>(byTest('session-title-trigger'));
    expect(dialog().find(byTest('allowed-root-chip')).exists()).toBe(false);
    expect(dialog().find(byTest('browse-manual-path-btn')).exists()).toBe(false);
    expect(dialog().find(byTest('session-title-input')).exists()).toBe(false);
    expect(dialog().text()).not.toMatch(/前往|浏览此路径|会话标题（可选）/u);
    expect(trigger().text()).toBe('新建排查会话');
    expect(dialog().get('h2').attributes('id')).toBe(dialog().attributes('aria-labelledby'));
    await trigger().trigger('click');
    const input = () => dialog().get<HTMLInputElement>(byTest('session-title-input'));
    expect(document.activeElement).toBe(input().element);
    await input().setValue('  自定义会话  ');
    await input().trigger('blur');
    expect(trigger().text()).toBe('自定义会话');
    await trigger().trigger('click');
    expect([input().element.selectionStart, input().element.selectionEnd]).toEqual([0, '自定义会话'.length]);
    await input().setValue('取消此次修改');
    await key(input().element, 'Escape');
    expect(dialog().find(byTest('session-title-input')).exists()).toBe(false);
    expect(trigger().text()).toBe('自定义会话');
    expect(document.activeElement).toBe(trigger().element);
    expect(sessionPosts(fetchImpl)).toEqual([]);
    for (const value of ['新建排查会话', ' \t ']) {
      await trigger().trigger('click');
      await input().setValue(value);
      await key(input().element, 'Enter');
      expect(trigger().text()).toBe('新建排查会话');
      await dialog().get(byTest('confirm-create-session-btn')).trigger('click');
      await flushPromises();
      await openPicker(wrapper);
    }
    expect(sessionPosts(fetchImpl)).toEqual([{ targetPath: '/safe' }, { targetPath: '/safe' }]);
  });

  it('U1-06 粘贴和失焦立即跳转，输入和组合态按 350ms 防抖，关闭清理定时器', async () => {
    const { wrapper, fetchImpl } = await setup({ browseAt: (path) => path ? { ...child, currentPath: path } : browse });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await openPicker(wrapper);
      const address = () => wrapper.get<HTMLInputElement>(byTest('path-address-input'));
      function addressed() {
        return fetchImpl.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'))
          .filter((url) => url.pathname === '/api/fs/browse' && url.searchParams.has('resolveFile'))
          .map((url) => [url.searchParams.get('path'), url.searchParams.get('resolveFile')]);
      }
      await paste(address().element, '/pasted');
      expect(addressed()).toEqual([['/pasted', '1']]);
      expect(wrapper.get(byTest('fs-entry-row')).text()).toContain('display-file');
      const summary = () => wrapper.get(byTest('path-selection-summary'));
      expect(summary().text()).toContain('目录');
      await address().setValue('/delayed');
      expect(summary().text()).toContain('delayed');
      await vi.advanceTimersByTimeAsync(349);
      expect(addressed()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(addressed().at(-1)).toEqual(['/delayed', '1']);
      await address().trigger('compositionstart');
      await address().setValue('/组合');
      await key(address().element, 'Enter');
      await vi.advanceTimersByTimeAsync(400);
      expect(addressed()).toHaveLength(2);
      await address().trigger('compositionend');
      await vi.advanceTimersByTimeAsync(350);
      expect(addressed().at(-1)).toEqual(['/组合', '1']);
      await address().setValue('/blurred');
      await address().trigger('blur', { relatedTarget: wrapper.get(byTest('fs-entry-row')).element });
      await flushPromises();
      expect(addressed().at(-1)).toEqual(['/blurred', '1']);
      await address().setValue('/not-requested');
      await wrapper.get(byTest('path-picker-cancel')).trigger('click');
      await vi.advanceTimersByTimeAsync(400);
      expect(addressed()).toHaveLength(4);
      expect(sessionPosts(fetchImpl)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('U1-07 粘贴文件时高亮精确路径，电脑根不可创建会话', async () => {
    const { wrapper, fetchImpl } = await setup({ browseAt: (path) => {
      if (path === actualFile) return { ...child, selectedFile: actualFile };
      if (path === COMPUTER_ROOT_PATH) return { currentPath: path, parentPath: null, allowedRoots: ['/safe'], entries: [
        { name: '盘符', path: '/safe', kind: 'dir' },
      ] };
      return { ...browse, parentPath: COMPUTER_ROOT_PATH };
    } });
    await openPicker(wrapper);
    const address = () => wrapper.get<HTMLInputElement>(byTest('path-address-input'));
    const parent = () => wrapper.get(byTest('path-parent-btn'));
    await parent().trigger('click');
    await flushPromises();
    expect(address().element.value).toBe('');
    expect(wrapper.get(byTest('path-selection-summary')).text()).toContain('未选择');
    expect(wrapper.get<HTMLButtonElement>(byTest('confirm-create-session-btn')).element.disabled).toBe(true);
    await paste(address().element, actualFile);
    expect(address().element.value).toBe(actualFile);
    expect(wrapper.get(byTest('fs-entry-row')).attributes('aria-pressed')).toBe('true');
    expect(wrapper.get(byTest('path-selection-summary')).text()).toContain('单文件');
    expect(sessionPosts(fetchImpl)).toEqual([]);
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    expect(sessionPosts(fetchImpl)).toEqual([{ targetPath: actualFile }]);
  });

  it('W1-07 按标题或路径筛选，斜杠聚焦，重挂载恢复最近选中项', async () => {
    const { wrapper, render } = await setup();
    const getItem = (id: string, root = wrapper) => root.get(byTest('session-item') + '[data-session-id="' + id + '"]');
    expect(getItem(first.id).attributes('data-active')).toBe('true');
    expect(getItem(second.id).attributes('data-running')).toBe('true');
    const filter = wrapper.get<HTMLInputElement>(byTest('session-filter-input'));
    wrapper.get<HTMLButtonElement>(byTest('new-session-btn')).element.focus();
    await key(window, '/');
    expect(document.activeElement).toBe(filter.element);
    const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    filter.element.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
    await filter.setValue('beta');
    expect(wrapper.findAll(byTest('session-item'))).toHaveLength(1);
    expect(getItem(second.id).text()).toContain('Beta');
    await filter.setValue('second.log');
    expect(wrapper.findAll(byTest('session-item'))).toHaveLength(1);
    await getItem(second.id).trigger('click');
    await flushPromises();
    expect(wrapper.get('main').text()).toContain(second.targetPath);
    expect(getItem(second.id).attributes('data-active')).toBe('true');
    expect(localStorage.getItem('mini-agent-run.active-session-id')).toBe(second.id);
    unmountAll();
    const restored = await render();
    expect(getItem(second.id, restored).attributes('data-active')).toBe('true');
    expect(restored.get('main').text()).toContain(second.title);
  });

  it('W1-07 快速切换时保留最后选择的会话详情', async () => {
    let hold = false;
    const past = deferred<Response>();
    const { wrapper } = await setup({ detailAt: (item) => {
      if (hold && item.id === second.id) return past.result;
      return Response.json({ session: item, hasActiveRun: false, runs: [] });
    } });
    const row = (id: string) => wrapper.get(byTest('session-item') + '[data-session-id="' + id + '"]');
    hold = true;
    await row(second.id).trigger('click');
    await row(first.id).trigger('click');
    await flushPromises();
    past.resolve(Response.json({ session: second, hasActiveRun: true, runs: [] }));
    await flushPromises();
    expect(wrapper.get('main').text()).toContain(first.title);
    expect(wrapper.get('main').text()).not.toContain(second.title);
    expect(row(first.id).attributes('data-active')).toBe('true');
  });

  it('W1-08 行内重命名拒绝空白、可取消、合法标题触发刷新', async () => {
    const { wrapper, fetchImpl } = await setup();
    const row = () => wrapper.get(byTest('session-item') + '[data-session-id="' + second.id + '"]');
    const enter = () => row().get(byTest('session-rename-btn')).trigger('click');
    const input = () => row().get(byTest('session-rename-input'));
    await enter();
    await input().setValue('    ');
    await input().trigger('keydown', { key: 'Enter' });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    await input().setValue('取消本次编辑');
    await input().trigger('keydown', { key: 'Escape' });
    expect(row().find(byTest('session-rename-input')).exists()).toBe(false);
    expect(row().text()).toContain(second.title);
    await enter();
    await input().setValue('  最新排查  ');
    await input().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const patch = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ title: '最新排查' });
    expect(wrapper.findAll(byTest('session-item'))[0]?.attributes('data-session-id')).toBe(second.id);
    expect(row().text()).toContain('最新排查');
  });

  it('W1-09 删除确认保护原始文件，409 保留条目，成功后自动切换', async () => {
    const { wrapper, api, fetchImpl } = await setup();
    api.conflict = true;
    const row = wrapper.get(byTest('session-item') + '[data-session-id="' + first.id + '"]');
    await row.get(byTest('session-delete-btn')).trigger('click');
    const dialog = () => wrapper.get(byTest('delete-session-alert'));
    expect(dialog().attributes('role')).toBe('alertdialog');
    expect(dialog().text()).toContain('绝不删除本机磁盘上的原始轨迹文件');
    expect(dialog().text()).toContain(first.targetPath);
    await dialog().get(byTest('confirm-delete-session-btn')).trigger('click');
    await flushPromises();
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(dialog().get('[role="alert"]').text()).toContain('请先停止后再删除');
    expect(wrapper.find('[data-session-id="' + first.id + '"]').exists()).toBe(true);
    api.conflict = false;
    await dialog().get(byTest('confirm-delete-session-btn')).trigger('click');
    await flushPromises();
    expect(wrapper.find(byTest('delete-session-alert')).exists()).toBe(false);
    expect(wrapper.findAll(byTest('session-item'))).toHaveLength(1);
    expect(wrapper.get(byTest('session-item')).attributes('data-active')).toBe('true');
    expect(wrapper.get('main').text()).toContain(second.title);
  });

  it('W1-10 会话标题、路径和浏览文件名保持纯文本', async () => {
    const title = '<script>window.__xss=1</script><img src=x onerror=alert(1)>';
    const path = '/safe/"><img src=x onerror=alert(1)>';
    const name = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
    const { wrapper } = await setup({
      sessions: [{ ...first, title, targetPath: path }],
      browseAt: () => ({ ...browse, currentPath: path, entries: [{ name, path: '/safe/real.log', kind: 'file' }] }),
    });
    const item = wrapper.get(byTest('session-item'));
    expect(item.text()).toContain(title);
    expect(item.findAll('[title]').some((el) => el.attributes('title') === path)).toBe(true);
    expect(wrapper.get('main h1').text()).toBe(title);
    expect(wrapper.get('main').text()).toContain(path);
    await openPicker(wrapper);
    expect(wrapper.get(byTest('fs-entry-row')).text()).toContain(name);
    expect(wrapper.get<HTMLInputElement>(byTest('path-address-input')).element.value).toBe(path);
    await wrapper.get(byTest('session-title-trigger')).trigger('click');
    await wrapper.get(byTest('session-title-input')).setValue(title);
    await key(wrapper.get(byTest('session-title-input')).element, 'Enter');
    expect(wrapper.get(byTest('session-title-trigger')).text()).toBe(title);
    expect(wrapper.get(byTest('path-selection-summary')).get('[title]').attributes('title')).toBe(path);
    await wrapper.get(byTest('fs-entry-row')).trigger('click');
    expect(wrapper.get(byTest('path-selection-summary')).text()).toContain(name);
    expect(wrapper.findAll('script, img, iframe')).toHaveLength(0);
    await key(window, 'Escape');
    await item.get(byTest('session-delete-btn')).trigger('click');
    const deletion = wrapper.get(byTest('delete-session-alert'));
    expect(deletion.text()).toContain(title);
    expect(deletion.text()).toContain(path);
    expect(wrapper.findAll('script, img')).toHaveLength(0);
  });
});
