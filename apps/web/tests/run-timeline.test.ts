// @vitest-environment happy-dom
import {
  type AgentEvent, type InvestigationRun, type RunEventEnvelope, type Session, type ToolOutputSummary,
} from '@mini-agent-run/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';
import { health, now, run, session } from './fixtures';
import { MockEventSource } from './mock-event-source';
import { closedRun, conclusion, frame } from './timeline-fixtures';

const second: Session = { ...session, id: 'ses_other', title: '备用会话', targetPath: '/safe/other.log', pathType: 'file' };
const test = (id: string) => '[data-testid="' + id + '"]';
const keyView = (id: string) => test('run-turn-block') + '[data-run-id="' + id + '"]';
const active = { ...run, status: 'running', startedAt: now } as const;
const wrappers: VueWrapper[] = [];
type View = { run: InvestigationRun; events: RunEventEnvelope[] };
type Mutation = { path: string; payload: Record<string, unknown>; sessionId?: string; sourceRunId?: string };

function problem(status: number, code: string) {
  return Response.json({ error: { code, message: 'Fixture failure.' } }, { status });
}

async function workbench(initial: View[] = [], options: { reverseRows?: boolean; missingHistory?: string } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal('innerWidth', 1440);
  const sources: MockEventSource[] = [];
  vi.stubGlobal('EventSource', class extends MockEventSource {
    constructor(url: string) { super(url); sources.push(this); }
  });
  const records = new Map(initial.map((view) => [view.run.id, view]));
  const mutations: Mutation[] = [];
  let created = 0;
  const controls: { launch?: (mutation: Mutation) => Response; stop?: (id: string) => Response } = {};
  const track = (record: InvestigationRun, events: RunEventEnvelope[] = []) => records.set(record.id, { run: record, events });
  const list = (owner: string) => [...records.values()].filter((value) => value.run.sessionId === owner).map((value) => value.run);
  const running = (items: InvestigationRun[]) => items.some(({ status }) => status === 'running' || status === 'pending');
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/health') return Response.json(health);
    if (path === '/api/sessions') return Response.json({ sessions: [session, second].map((item) => {
      const runs = list(item.id);
      return { ...item, runCount: runs.length, hasActiveRun: running(runs) };
    }) });
    const create = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path)?.[1];
    const retry = /^\/api\/runs\/([^/]+)\/retry$/.exec(path)?.[1];
    if (create || retry) {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const mutation = { path, payload, sessionId: create, sourceRunId: retry };
      mutations.push(mutation);
      if (controls.launch) return controls.launch(mutation);
      const original = retry ? records.get(retry)?.run : undefined;
      const pending: InvestigationRun = {
        ...run, id: 'run_local_' + ++created, sessionId: create ?? original?.sessionId ?? session.id,
        retryOfRunId: retry ?? null, prompt: typeof payload.prompt === 'string' ? payload.prompt : original?.prompt ?? run.prompt,
        createdAt: new Date(Date.parse(now) + 1000 + created).toISOString(),
      };
      track(pending);
      return Response.json(pending, { status: 201 });
    }
    const stop = /^\/api\/runs\/([^/]+)\/stop$/.exec(path)?.[1];
    if (stop) {
      mutations.push({ path, payload: {} });
      return controls.stop?.(stop) ?? Response.json({ runId: stop, status: 'stopping' }, { status: 202 });
    }
    const known = /^\/api\/runs\/([^/]+)$/.exec(path)?.[1];
    if (known) {
      const entry = records.get(known);
      return entry && known !== options.missingHistory ? Response.json(entry) : problem(404, 'RUN_NOT_FOUND');
    }
    const selected = [session, second].find(({ id }) => path === '/api/sessions/' + id);
    if (selected) {
      const runs = list(selected.id);
      return Response.json({ session: selected, runs: options.reverseRows ? runs.reverse() : runs, hasActiveRun: running(runs) });
    }
    return problem(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchImpl);
  const wrapper = mount(App, { attachTo: document.body, global: { stubs: { teleport: true } } });
  wrappers.push(wrapper);
  await flushPromises();

  async function emit(id: string, seq: number, event: AgentEvent) {
    const envelope = frame(seq, event, id);
    const entry = records.get(id);
    if (entry && seq > entry.run.lastSeq) {
      const ending = event.type === 'agent_end' ? {
        status: event.status, stopReason: event.stopReason, endedAt: now, durationMs: event.durationMs,
        finalAnswer: event.finalAnswer ?? null, conclusion: event.conclusion ?? null,
        errorCode: event.error?.code ?? null, errorMessage: event.error?.message ?? null,
      } : {};
      const status = event.type === 'agent_start' ? { status: 'running' as const } : {};
      track({ ...entry.run, ...status, ...ending, lastSeq: seq }, [...entry.events, envelope]);
    }
    const connection = sources.slice().reverse().find((source) => source.closeCount === 0 && source.url.startsWith('/api/runs/' + id + '/'));
    if (!connection) throw new Error('No open connection for ' + id);
    connection.emit(envelope);
    await flushPromises();
  }
  const el = (id: string) => wrapper.get(test(id));
  const prompt = () => wrapper.get<HTMLTextAreaElement>(test('prompt-input'));
  const sidebar = (id = session.id) => wrapper.get(test('session-item') + '[data-session-id="' + id + '"]');
  const turn = (id = run.id) => wrapper.get(keyView(id));
  return { wrapper, sources, records, controls, mutations, fetchImpl, track, emit, el, prompt, sidebar, turn };
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const delta = (text: string): AgentEvent => ({ type: 'message_update', messageId: 'msg_flow', deltaType: 'text_delta', delta: text });
const finish = (event: Partial<Extract<AgentEvent, { type: 'agent_end' }>> = {}): AgentEvent => ({
  type: 'agent_end', status: 'completed', stopReason: 'completed', durationMs: 2350, ...event,
});

describe('F10_TIMELINE_AND_CONTROL_UI 挂载工作台', () => {
  it('W2-03 开放式空会话，保留斜杠和组合输入，只由普通 Enter 提交', async () => {
    const ui = await workbench();
    const empty = ui.el('empty-session-guide');
    expect(empty.text()).toContain(session.targetPath);
    expect(empty.findAll('button')).toHaveLength(0);
    expect(ui.wrapper.get('main > :first-child h1').text()).toBe(session.title);
    await ui.prompt().setValue('排查第一行\n第二行');
    ui.prompt().element.focus();
    const slash = new KeyboardEvent('keydown', { key: '/', cancelable: true, bubbles: true });
    ui.prompt().element.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(ui.prompt().element);
    await ui.prompt().trigger('keydown', { key: 'Enter', shiftKey: true });
    await ui.prompt().trigger('keydown', { key: 'Enter', isComposing: true });
    expect(ui.mutations).toHaveLength(0);
    await ui.prompt().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(ui.mutations.map(({ path, payload }) => ({ path, payload }))).toEqual([
      { path: '/api/sessions/' + session.id + '/runs', payload: { prompt: '排查第一行\n第二行' } },
    ]);
    expect(ui.sidebar().attributes('data-running')).toBe('true');
    expect(ui.sidebar().text()).toContain('1');
    expect(ui.sources[0]?.url).toBe('/api/runs/run_local_1/stream?afterSeq=0');
    expect(ui.prompt().element.disabled).toBe(true);
  });

  it('W2-04 历史按发生顺序展示，局部拉取错误不阻塞活跃流与折叠详情', async () => {
    const earlier = { ...closedRun, id: 'run_earlier', finalAnswer: '早期结论' };
    const late = { ...active, createdAt: new Date(Date.parse(now) + 2000).toISOString(), lastSeq: 2 };
    const ui = await workbench([
      { run: earlier, events: [] },
      { run: late, events: [frame(1, { type: 'turn_start', step: 1 }), frame(2, delta('历史正文'))] },
    ], { reverseRows: true, missingHistory: earlier.id });
    expect(ui.wrapper.findAll(test('run-turn-block')).map((card) => card.attributes('data-run-id'))).toEqual([earlier.id, run.id]);
    expect(ui.turn(earlier.id).text()).toContain('早期结论');
    expect(ui.sources[0]?.url).toBe('/api/runs/' + run.id + '/stream?afterSeq=2');
    ui.sources[0]?.emit(frame(2, delta('重复内容')));
    await ui.emit(run.id, 3, { type: 'tool_execution_start', toolCallId: 'tc_search', toolName: 'search_logs', step: 1, arguments: { file: 'demo.log' } });
    await ui.emit(run.id, 4, { type: 'tool_execution_update', toolCallId: 'tc_search', toolName: 'search_logs', elapsedMs: 900, progressMessage: '正在读取' });
    expect(ui.el('active-tool-status').text()).toContain('search_logs');
    expect(ui.el('active-tool-status').text()).toContain('正在读取');
    expect(ui.turn().text()).not.toContain('重复内容');
    expect(ui.wrapper.find(test('tool-call-card')).exists()).toBe(false);
    await ui.el('run-details-toggle').trigger('click');
    expect(ui.el('tool-call-card').attributes('data-tool-id')).toBe('tc_search');
    await ui.el('tool-toggle-btn').trigger('click');
    expect(ui.el('tool-call-card').text()).toContain('demo.log');
    await ui.emit(run.id, 5, { type: 'tool_execution_end', toolCallId: 'tc_search', toolName: 'search_logs', step: 1,
      durationMs: 1200, isError: false, preview: '工具预览' });
    expect(ui.el('tool-call-card').text()).toContain('工具预览');
    expect(ui.wrapper.find(test('active-tool-status')).exists()).toBe(false);
  });

  it('W2-05 断线接续最新游标并可回退终态，切换和卸载关闭连接', async () => {
    const ui = await workbench([{ run: active, events: [] }]);
    await ui.emit(run.id, 1, delta('首段'));
    const firstSource = ui.sources[0]!;
    firstSource.fail();
    await flushPromises();
    expect(ui.el('sse-reconnecting-banner').attributes('role')).toBe('status');
    expect(firstSource.closeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(ui.sources[1]?.url).toBe('/api/runs/run_fixture/stream?afterSeq=1');
    firstSource.emit(frame(2, delta('忽略旧连接')));
    await ui.emit(run.id, 2, delta('新段'));
    expect(ui.turn().text()).toContain('首段新段');
    expect(ui.wrapper.find(test('sse-reconnecting-banner')).exists()).toBe(false);
    ui.sources[1]?.fail();
    ui.track({ ...closedRun, finalAnswer: 'REST 终态', lastSeq: 2 });
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(ui.sources).toHaveLength(2);
    expect(ui.turn().attributes('data-run-status')).toBe('completed');
    expect(ui.turn().text()).toContain('REST 终态');

    await ui.prompt().setValue('生成新轮次');
    await ui.prompt().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const newSource = ui.sources[2]!;
    await ui.sidebar(second.id).trigger('click');
    await flushPromises();
    expect(newSource.closeCount).toBe(1);
    expect(ui.wrapper.find(keyView('run_local_1')).exists()).toBe(false);
    await ui.sidebar().trigger('click');
    await flushPromises();
    const reopened = ui.sources[3]!;
    ui.wrapper.unmount();
    wrappers.pop();
    expect(reopened.closeCount).toBe(1);
  });

  it('W2-06 停止在终态前持续锁定，alreadyTerminal 用详情幂等收敛', async () => {
    const ui = await workbench([{ run: active, events: [] }]);
    expect(ui.prompt().element.disabled).toBe(true);
    expect(ui.wrapper.find(test('send-run-btn')).exists()).toBe(false);
    await ui.el('stop-run-btn').trigger('click');
    await flushPromises();
    expect(ui.mutations).toEqual([{ path: '/api/runs/' + run.id + '/stop', payload: {} }]);
    expect(ui.el('stop-run-btn').attributes('disabled')).toBeDefined();
    await ui.emit(run.id, 1, finish({ status: 'stopped', stopReason: 'user_abort' }));
    expect(ui.turn().get('[data-run-badge="stopped"]').classes()).toContain('stopped');
    expect(ui.prompt().element.disabled).toBe(false);
    expect(ui.sidebar().attributes('data-running')).toBe('false');

    await ui.prompt().setValue('停止竞态');
    await ui.el('send-run-btn').trigger('click');
    await flushPromises();
    const id = 'run_local_1';
    const created = ui.records.get(id)!.run;
    ui.controls.stop = (stopId) => {
      ui.track({ ...closedRun, ...created, status: 'stopped', stopReason: 'user_abort', endedAt: now, durationMs: 100 });
      return Response.json({ runId: stopId, status: 'stopped', alreadyTerminal: true });
    };
    await ui.el('stop-run-btn').trigger('click');
    await flushPromises();
    expect(ui.fetchImpl).toHaveBeenCalledWith('/api/runs/' + id, expect.anything());
    expect(ui.turn(id).attributes('data-run-status')).toBe('stopped');
    expect(ui.sources[1]?.closeCount).toBe(1);
    expect(ui.prompt().element.disabled).toBe(false);
  });

  it('W2-07 重跑严格关联原记录，可回填、取消、修改及回跳', async () => {
    const stopped = { ...closedRun, id: 'run_stopped', status: 'stopped', stopReason: 'user_abort', prompt: '停止的问题' } as const;
    const failed = { ...closedRun, id: 'run_failed', status: 'failed', stopReason: 'error', prompt: '失败的问题' } as const;
    const ui = await workbench([closedRun, stopped, failed].map((record) => ({ run: record, events: [] })));
    expect(ui.turn().find(test('retry-run-btn')).exists()).toBe(false);
    expect(ui.turn().find(test('edit-retry-run-btn')).exists()).toBe(false);
    for (const id of [stopped.id, failed.id]) {
      expect(ui.turn(id).find(test('retry-run-btn')).exists()).toBe(true);
      expect(ui.turn(id).find(test('edit-retry-run-btn')).exists()).toBe(true);
    }
    await ui.turn(stopped.id).get(test('retry-run-btn')).trigger('click');
    await flushPromises();
    expect(ui.mutations[0]).toMatchObject({ path: '/api/runs/' + stopped.id + '/retry', payload: {} });
    expect(ui.turn('run_local_1').text()).toContain(stopped.prompt);
    await ui.turn('run_local_1').get(test('retry-origin-link')).trigger('click');
    expect(ui.turn(stopped.id).classes()).toContain('highlighted');
    expect(document.activeElement).toBe(ui.turn(stopped.id).element);
    await ui.emit('run_local_1', 1, finish());
    await ui.prompt().setValue('草稿');
    await ui.turn(failed.id).get(test('edit-retry-run-btn')).trigger('click');
    expect(ui.prompt().element.value).toBe(failed.prompt);
    expect(ui.wrapper.find(test('cancel-retry-edit-btn')).exists()).toBe(true);
    await ui.el('cancel-retry-edit-btn').trigger('click');
    expect(ui.prompt().element.value).toBe('草稿');
    await ui.turn(failed.id).get(test('edit-retry-run-btn')).trigger('click');
    await ui.prompt().setValue('修订的问题');
    await ui.prompt().trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(ui.mutations[1]).toMatchObject({ path: '/api/runs/' + failed.id + '/retry', payload: { prompt: '修订的问题' } });
    expect(ui.wrapper.find(test('cancel-retry-edit-btn')).exists()).toBe(false);
    expect(ui.turn('run_local_2').get(test('retry-origin-link')).text()).toContain(failed.id);
  });

  it('W2-08 模型未配置可唤起设置，并发冲突接管活跃运行，达到重跑上限时提示', async () => {
    const failed = { ...closedRun, status: 'failed', stopReason: 'error' } as const;
    const ui = await workbench([{ run: failed, events: [] }]);
    ui.controls.launch = () => problem(503, 'LLM_NOT_CONFIGURED');
    await ui.prompt().setValue('从失败中继续');
    await ui.el('send-run-btn').trigger('click');
    await flushPromises();
    expect(ui.el('run-issue-banner').text()).toContain('模型 API Key');
    await ui.el('open-settings-from-error-btn').trigger('click');
    expect(ui.el('settings-modal').text()).toContain('设置');
    await ui.el('settings-modal').get('[aria-label="关闭"]').trigger('click');
    expect(ui.prompt().element.value).toBe('从失败中继续');

    const conflict = { ...active, id: 'run_conflict' };
    ui.controls.launch = () => {
      ui.track(conflict);
      return problem(409, 'SESSION_HAS_ACTIVE_RUN');
    };
    await ui.el('send-run-btn').trigger('click');
    await flushPromises();
    expect(ui.el('run-issue-banner').text()).toContain('已有运行中的排查任务');
    expect(ui.sources[0]?.url).toBe('/api/runs/' + conflict.id + '/stream?afterSeq=0');
    expect(ui.sidebar().attributes('data-running')).toBe('true');
    await ui.emit(conflict.id, 1, finish());
    ui.controls.launch = () => problem(409, 'RETRY_LIMIT_EXCEEDED');
    await ui.el('retry-run-btn').trigger('click');
    await flushPromises();
    expect(ui.el('run-issue-banner').text()).toContain('最大重试次数（3 次）');
    expect(ui.wrapper.find(test('open-settings-from-error-btn')).exists()).toBe(false);
  });

  it('W2-09 精简会话页眉与工具详情，三态独立，按证据类型打开纯文本右栏', async () => {
    const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))';
    const report = { ...conclusion, summary: hostile, recommendations: [hostile] };
    const summary: ToolOutputSummary = { byteSize: 130, lineCount: 16, truncatedForLlm: true,
      levelCounts: { error: 1, warn: 0, info: 0, other: 15 }, firstErrorLine: 15, previewHead: hostile };
    const toolEvents: AgentEvent[] = [
      { type: 'tool_execution_start', toolCallId: 'tc_first', toolName: 'search_logs', step: 1, arguments: { file: hostile } },
      { type: 'tool_execution_end', toolCallId: 'tc_first', toolName: 'search_logs', step: 1, durationMs: 800,
        isError: false, preview: hostile, artifactId: 'art_fixture', summary },
      { type: 'tool_execution_start', toolCallId: 'tc_second', toolName: 'search_logs', step: 2, arguments: { file: 'second.log' } },
      { type: 'tool_execution_end', toolCallId: 'tc_second', toolName: 'search_logs', step: 2,
        durationMs: 1800, isError: false, preview: '已完成' },
      finish({ conclusion: report, finalAnswer: hostile }),
    ];
    const ui = await workbench([{ run: { ...closedRun, conclusion: report, lastSeq: toolEvents.length },
      events: toolEvents.map((item, index) => frame(index + 1, item)) }]);
    expect(ui.el('three-state-group').findAll('[data-assessment]').map((node) => node.text())).toEqual([
      '终止原因 user_stop', '无工具报错', '任务结果 失败',
    ]);
    expect(ui.el('conclusion-card').text()).toContain(hostile);
    expect(ui.el('safe-markdown-view').text()).toContain(hostile);
    expect(ui.wrapper.find('img, iframe, a[href], script').exists()).toBe(false);
    expect(ui.wrapper.get('.session-header h1').text()).not.toBe('');
    expect(ui.wrapper.get('.session-header').find('code').exists()).toBe(false);
    expect(ui.wrapper.find('.topbar-context').exists()).toBe(false);
    for (const button of ['jump-first-error-btn', 'jump-retry-loop-btn', 'jump-slow-tool-btn']) {
      expect(ui.wrapper.find(test(button)).exists()).toBe(false);
    }

    const inspector = () => ui.el('inspector-target-preview');
    const chip = (kind: string) => ui.wrapper.get(test('evidence-chip') + '[data-evidence-kind="' + kind + '"]');
    await ui.el('run-details-toggle').trigger('click');
    const first = ui.wrapper.get(test('tool-call-card') + '[data-tool-id="tc_first"]');
    await first.get(test('tool-toggle-btn')).trigger('click');
    expect(first.get(test('tool-toggle-btn')).attributes('aria-expanded')).toBe('true');
    expect(first.text()).toContain(hostile);
    expect(first.find('img').exists()).toBe(false);
    await first.get(test('tool-inspect-btn')).trigger('click');
    expect(inspector().attributes('data-target-mode')).toBe('artifact');
    expect(inspector().text()).toMatch(/art_fixture.*L15/s);

    const secondTool = ui.wrapper.get(test('tool-call-card') + '[data-tool-id="tc_second"]');
    await secondTool.get(test('tool-toggle-btn')).trigger('click');
    expect(secondTool.get(test('tool-toggle-btn')).attributes('aria-expanded')).toBe('true');
    await secondTool.get(test('tool-inspect-btn')).trigger('click');
    expect(inspector().text()).toContain('second.log');
    await first.get(test('tool-inspect-btn')).trigger('click');
    expect(inspector().text()).toContain('art_fixture');
    await chip('file_line').trigger('click');
    expect(inspector().attributes('data-target-mode')).toBe('file');
    expect(inspector().text()).toMatch(/原始日志.*trace\.log.*L8–L10/s);
    await chip('artifact_line').trigger('click');
    expect(inspector().text()).toMatch(/工具日志.*art_fixture.*L15/s);
    await chip('file_step').trigger('click');
    expect(inspector().text()).toMatch(/trace\.log.*Step #0/s);
    await ui.sidebar(second.id).trigger('click');
    expect(ui.wrapper.find(test('inspector-target-preview')).exists()).toBe(false);
  });

  it('W2-10 48 px 边界内跟随流，离底保持位置，胶囊恢复吸底', async () => {
    const ui = await workbench([{ run: active, events: [] }]);
    const timeline = ui.el('run-timeline-scroll');
    let height = 1000;
    let top = 552;
    Object.defineProperties(timeline.element, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 400 },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.min(value, height - 400); } },
    });
    await timeline.trigger('scroll');
    height = 1100;
    await ui.emit(run.id, 1, delta('跟随'));
    expect(top).toBe(700);
    expect(ui.wrapper.find(test('scroll-to-bottom-pill')).exists()).toBe(false);
    top = 651;
    await timeline.trigger('scroll');
    expect(ui.el('scroll-to-bottom-pill').text()).toContain('回到底部');
    height = 1300;
    await ui.emit(run.id, 2, delta('留在历史位置'));
    expect(top).toBe(651);
    await ui.el('scroll-to-bottom-pill').trigger('click');
    expect(top).toBe(900);
    expect(ui.wrapper.find(test('scroll-to-bottom-pill')).exists()).toBe(false);
  });
});
