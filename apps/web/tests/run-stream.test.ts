import { flushPromises } from '@vue/test-utils';
import type { InvestigationRun, SessionDetail } from '@mini-agent-run/shared';
import { effectScope, shallowRef } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRunStream, type RunStreamClient } from '../src/composables/useRunStream';
import { now, run, session } from './fixtures';
import { closedRun, frame } from './timeline-fixtures';
import { deferred, MockEventSource } from './mock-event-source';

const active = { ...run, status: 'running', startedAt: now } as const;
const detail = (runs: InvestigationRun[]): SessionDetail => ({ session, hasActiveRun: runs.some(({ status }) => status === 'running'), runs });
const scopes: ReturnType<typeof effectScope>[] = [];
const textFrame = (seq: number, delta: string) => frame(seq, { type: 'message_update', messageId: 'msg_test', deltaType: 'text_delta', delta });

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});

function setup(configuration: Partial<Parameters<typeof useRunStream>[0]> = {}) {
  const id = shallowRef<string | null>(session.id);
  const selected = shallowRef<SessionDetail | null>(detail([active]));
  const sources: MockEventSource[] = [];
  const client = {
    getRunDetail: vi.fn<RunStreamClient['getRunDetail']>(async () => ({ run: active, events: [] })),
    startRun: vi.fn<RunStreamClient['startRun']>(),
    stopRun: vi.fn<RunStreamClient['stopRun']>(),
    retryRun: vi.fn<RunStreamClient['retryRun']>(),
    buildRunStreamUrl: (runId: string, seq?: number) => '/api/runs/' + runId + '/stream?afterSeq=' + (seq ?? 0),
  };
  const sync = vi.fn();
  const scope = effectScope();
  scopes.push(scope);
  const stream = scope.run(() => useRunStream({
    sessionId: id, sessionDetail: selected, client, syncSessionRunState: sync, reconnectDelayMs: 0, ...configuration,
    eventSourceFactory(url) {
      const source = new MockEventSource(url);
      sources.push(source);
      return source;
    },
  }));
  if (!stream) throw new Error('Could not initialize stream scope.');
  return { id, selected, client, sources, sync, stream, scope };
}

describe('F10_TIMELINE_AND_CONTROL_UI SSE 生命周期', () => {
  it('在历史读取后使用收到的 seq 续流、校验具名帧，并丢弃旧连接', async () => {
    const history = deferred<{ run: InvestigationRun; events: ReturnType<typeof textFrame>[] }>();
    const { client, sources, stream, id, selected, sync } = setup({ maxReconnectAttempts: 3 });
    // A detail refresh while the first request is in flight supersedes it.
    client.getRunDetail.mockReturnValueOnce(history.promise);
    selected.value = detail([active]);
    history.resolve({ run: active, events: [textFrame(1, '历史')] });
    await flushPromises();
    expect(sources.map(({ url }) => url)).toEqual(['/api/runs/run_fixture/stream?afterSeq=1']);
    const original = sources[0]!;
    original.emit(textFrame(1, '应被跳过'));
    original.emitRaw('message_update', JSON.stringify({ ...textFrame(2, '无效'), event: { type: 'message_update' } }));
    original.emit(textFrame(2, '新增'));
    original.fail();
    expect(stream.reconnectingRunId.value).toBe(run.id);
    await flushPromises();
    expect(sources[1]?.url).toBe('/api/runs/run_fixture/stream?afterSeq=2');
    expect(original.closeCount).toBe(1);
    original.emit(textFrame(3, '旧连接'));
    sources[1]?.emit(textFrame(3, '续流'));
    expect(stream.turns.value[0]?.streamText).toBe('历史新增续流');
    expect(stream.reconnectingRunId.value).toBeNull();
    id.value = 'ses_different';
    expect(sources[1]?.closeCount).toBe(1);
    sources[1]?.emit(frame(4, { type: 'agent_end', durationMs: 7, status: 'completed', stopReason: 'completed' }));
    expect(stream.turns.value).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });

  it('重连前经 REST 发现终态，停止继续重连并同步左栏', async () => {
    const { client, sources, stream, sync } = setup();
    await flushPromises();
    client.getRunDetail.mockResolvedValueOnce({ run: { ...closedRun, finalAnswer: '已完成' }, events: [] });
    sources[0]?.fail();
    await flushPromises();
    expect(sources).toHaveLength(1);
    expect(stream.activeRun.value).toBeNull();
    expect(stream.turns.value[0]?.streamText).toBe('已完成');
    expect(stream.reconnectingRunId.value).toBeNull();
    expect(sync).toHaveBeenCalledWith(session.id, { hasActiveRun: false, runCount: 1 });
  });

  it('重连限制与计时器依赖于当前会话和作用域', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { sources, stream, scope } = setup({ maxReconnectAttempts: 2, reconnectDelayMs: 300 });
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    sources[0]?.fail();
    await vi.advanceTimersByTimeAsync(299);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    sources[1]?.fail();
    await vi.advanceTimersByTimeAsync(300);
    sources[2]?.fail();
    await flushPromises();
    expect(sources).toHaveLength(3);
    expect(stream.reconnectExhausted.value).toBe(true);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(sources.map(({ closeCount }) => closeCount)).toEqual([1, 1, 1]);
  });

  it('切换会话后迟到的历史响应不能添加旧轮次或开启连接', async () => {
    const stale = deferred<{ run: InvestigationRun; events: [] }>();
    const { client, id, selected, sources, stream } = setup();
    client.getRunDetail.mockReturnValueOnce(stale.promise);
    selected.value = detail([active]);
    id.value = 'ses_new';
    selected.value = { session: { ...session, id: 'ses_new' }, runs: [], hasActiveRun: false };
    stale.resolve({ run: active, events: [] });
    await flushPromises();
    expect(stream.turns.value).toEqual([]);
    expect(sources).toEqual([]);
  });
});
