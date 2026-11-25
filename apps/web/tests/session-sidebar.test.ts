// @vitest-environment happy-dom
import { CreateSessionRequestSchema, UpdateSessionRequestSchema, type FsBrowseResponse, type SessionListItem } from '@mini-agent-run/shared';
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
    expect(divider.attributes('aria-valuenow')).toBe('720');
    expect(localStorage.getItem('mini-agent-run.inspector-width')).toBe('720');
    await resize(1100);
    expect(wrapper.find(byTest('inspector-divider')).exists()).toBe(false);
    expect(wrapper.get('#inspector-panel').attributes('role')).toBe('dialog');
    await key(window, 'Escape');
    expect(wrapper.find('#inspector-panel').exists()).toBe(false);
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
    await entry().trigger('click');
    expect(entry().attributes('aria-pressed')).toBe('false');
    await entry().trigger('click');
    await wrapper.get(byTest('session-title-input')).setValue('文件检查');
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    const posts = fetchImpl.mock.calls.filter(([url, init]) => url === '/api/sessions' && init?.method === 'POST');
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { targetPath: folder }, { targetPath: actualFile, title: '文件检查' },
    ]);
    expect(wrapper.get('main').text()).toContain(actualFile);
  });

  it('W1-05 根目录与键盘导航丢弃过期的成功及失败响应', async () => {
    let older = deferred<FsBrowseResponse | Response>();
    let latest = deferred<FsBrowseResponse | Response>();
    let racing = false;
    const { wrapper } = await setup({ browseAt: (path) => {
      if (path === folder) return child;
      if (path === '/other') return latest.result;
      if (path === '/safe' && racing) return older.result;
      return browse;
    } });
    await openPicker(wrapper);
    const parent = () => wrapper.get<HTMLButtonElement>(byTest('path-parent-btn'));
    expect(parent().element.disabled).toBe(true);
    const dialog = wrapper.get(byTest('path-picker-modal'));
    const link = () => wrapper.get(byTest('fs-entry-row'));
    const manual = () => wrapper.get<HTMLInputElement>(byTest('manual-path-input'));
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

    const safe = () => wrapper.get(byTest('allowed-root-chip') + '[title="/safe"]');
    const other = () => wrapper.get(byTest('allowed-root-chip') + '[title="/other"]');
    racing = true;
    await safe().trigger('click');
    await other().trigger('click');
    latest.resolve({ ...browse, currentPath: '/other', entries: [] });
    await flushPromises();
    expect(dialog.text()).toContain('/other');
    older.resolve(problem(403, 'PATH_OUTSIDE_ALLOWED_ROOTS'));
    await flushPromises();
    expect(dialog.find(byTest('path-error-banner')).exists()).toBe(false);
    expect(wrapper.get(byTest('current-path')).text()).toBe('/other');
    older = deferred();
    latest = deferred();
    await safe().trigger('click');
    await other().trigger('click');
    latest.resolve({ ...browse, currentPath: '/other/recent' });
    await flushPromises();
    older.resolve(browse);
    await flushPromises();
    expect(wrapper.get(byTest('current-path')).text()).toBe('/other/recent');
  });

  it('W1-06 按 403、404、503 和 400 区分路径错误，并直接提交手动路径', async () => {
    const checks = [
      [403, 'PATH_OUTSIDE_ALLOWED_ROOTS', 'forbidden', '白名单'],
      [404, 'PATH_NOT_FOUND', 'not-found', '不存在'],
      [503, 'NO_ACCESSIBLE_ROOTS', 'unavailable', '未配置'],
      [400, 'INVALID_PATH', 'invalid', '无效'],
    ] as const;
    const { wrapper, fetchImpl } = await setup({ browseAt: (path) => {
      const match = checks.find(([status]) => path === 'bad-' + status);
      return match ? problem(match[0], match[1]) : browse;
    } });
    await openPicker(wrapper);
    const input = () => wrapper.get(byTest('manual-path-input'));
    for (const [status, , severity, message] of checks) {
      await input().setValue('bad-' + status);
      await wrapper.get(byTest('browse-manual-path-btn')).trigger('click');
      await flushPromises();
      const banner = wrapper.get(byTest('path-error-banner'));
      expect(banner.attributes('role')).toBe('alert');
      expect(banner.text()).toContain(String(status));
      expect(banner.text()).toContain(message);
      expect(input().classes()).toContain('uiv-path-input--' + severity);
    }
    const manual = 'D:\\scope\\轨迹 #2.jsonl';
    await input().setValue('  ' + manual + '  ');
    await wrapper.get(byTest('confirm-create-session-btn')).trigger('click');
    await flushPromises();
    const post = fetchImpl.mock.calls.find(([url, init]) => url === '/api/sessions' && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ targetPath: manual });
    expect(wrapper.get('main').text()).toContain(manual);
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
    expect(wrapper.get(byTest('current-path')).text()).toBe(path);
    expect(wrapper.findAll('script, img')).toHaveLength(0);
    await key(window, 'Escape');
    await item.get(byTest('session-delete-btn')).trigger('click');
    const deletion = wrapper.get(byTest('delete-session-alert'));
    expect(deletion.text()).toContain(title);
    expect(deletion.text()).toContain(path);
    expect(wrapper.findAll('script, img')).toHaveLength(0);
  });
});
