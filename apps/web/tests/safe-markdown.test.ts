// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import SafeMarkdownView from '../src/components/timeline/SafeMarkdownView.vue';
import { formatBytes, formatDurationMs, formatRelativeTime, formatRunStatus, formatStopReason, formatTaskOutcome } from '../src/utils/formatters';
import { applyRunEventEnvelope, createRunTurnViewModel } from '../src/utils/runTimelineReducer';
import { parseSafeMarkdown } from '../src/utils/safeMarkdown';
import { now, run } from './fixtures';
import { closedRun, conclusion, frame } from './timeline-fixtures';

const fenced = String.fromCharCode(96).repeat(3);
const attack = '<script>alert(1)</script><img src=x onerror=alert(1)><iframe></iframe>[x](javascript:alert(1))';

describe('F10_TIMELINE_AND_CONTROL_UI Markdown 和事件归约', () => {
  it('W2-01 保留 100 组含标签、孤立代理项及未闭合围栏的输入', () => {
    const arbitrary = fc.array(fc.oneof(fc.string(), fc.constantFrom('\r\n', '\n', '\r', '  ', '\uD800', attack, fenced, '**')), {
      maxLength: 24,
    });
    fc.assert(fc.property(arbitrary, (fragments) => {
      const suffix = attack + '\uD800' + fragments.join('');
      const source = attack + '\r\n\r\n' + fenced + 'text\r\n' + suffix;
      const blocks = parseSafeMarkdown(source);
      expect(blocks.map(({ source }) => source).join('')).toBe(source);
      expect(blocks[0]).toMatchObject({ type: 'paragraph', tokens: [{ type: 'text', text: attack }] });
      const code = blocks.find((block) => block.type === 'code_block');
      expect(code?.code.startsWith(attack + '\uD800')).toBe(true);
    }), { seed: 3201, numRuns: 100 });
  });

  it('W2-01 纯文本渲染标题、列表和代码块，复制保留换行并安全降级', async () => {
    const clipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const writer = vi.spyOn(window.navigator.clipboard, 'writeText').mockImplementation(clipboard);
    const code = attack + '\r\n  保留缩进\n';
    const source = '# 标题 ' + attack + '\n\n- 列表 ' + attack + '\n\n1. 第一步\n2. 第二步\n\n'
      + '正文 **重点** ' + String.fromCharCode(96) + '代码' + String.fromCharCode(96)
      + '\n\n' + fenced + 'html\n' + code + fenced;
    const wrapper = mount(SafeMarkdownView, { props: { content: source } });
    try {
      expect(wrapper.get('h1').element.textContent).toBe('标题 ' + attack);
      expect(wrapper.get('ul li').element.textContent).toBe('列表 ' + attack);
      expect(wrapper.findAll('ol li')).toHaveLength(2);
      expect(wrapper.get('strong').text()).toBe('重点');
      expect(wrapper.get('p code').text()).toBe('代码');
      expect(wrapper.get('pre code').element.textContent).toBe(code);
      expect(wrapper.findAll('script, img, iframe, a')).toHaveLength(0);
      await wrapper.get('[data-testid="copy-markdown-code-btn"]').trigger('click');
      expect(clipboard).toHaveBeenCalledWith(code);
      clipboard.mockRejectedValueOnce(new Error('clipboard denied'));
      await wrapper.get('[data-testid="copy-markdown-code-btn"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[role="status"]').text()).toContain('无法复制');
    } finally { writer.mockRestore(); wrapper.unmount(); }
  });

  it('W2-02 处理全部事件、保留多步文本并隔离重放、重复工具 ID 和终态正文', () => {
    const beginning = [
      frame(1, { type: 'agent_start', sessionId: run.sessionId, modelId: run.modelId, prompt: run.prompt, maxSteps: 12 }),
      frame(2, { type: 'turn_start', step: 1 }),
      frame(3, { type: 'message_start', role: 'assistant', messageId: 'msg_one' }),
      frame(4, { type: 'message_update', deltaType: 'text_delta', messageId: 'msg_one', delta: '检查' }),
      frame(5, { type: 'message_update', deltaType: 'text_delta', messageId: 'msg_one', delta: '完成' }),
      frame(6, { type: 'message_end', message: { id: 'msg_one', role: 'assistant', content: '检查完成', createdAt: now, toolCalls: [] } }),
      frame(7, { type: 'tool_execution_start', toolCallId: 'tc_same', toolName: 'search_logs', step: 1, arguments: { file: 'trace.log' } }),
      frame(8, { type: 'tool_execution_update', toolCallId: 'tc_same', toolName: 'search_logs', elapsedMs: 350, progressMessage: '读取中' }),
    ];
    const active = createRunTurnViewModel(run, beginning);
    expect(active.streamText).toBe('检查完成');
    expect(active.activeTool).toMatchObject({ toolCallId: 'tc_same', step: 1, elapsedMs: 350, progressMessage: '读取中' });
    expect(active.highSignals).toEqual({ firstError: null, retryLoop: null, slowTool: null });
    expect(applyRunEventEnvelope(active, beginning[3]!)).toBe(active);
    expect(applyRunEventEnvelope(active, beginning[6]!)).toBe(active);
    const tail = [
      frame(9, { type: 'tool_execution_end', toolCallId: 'tc_same', toolName: 'search_logs', step: 1,
        durationMs: 1700, isError: true, preview: '失败', artifactId: 'art_fixture' }),
      frame(10, { type: 'turn_end', step: 1, toolCallCount: 1 }),
      frame(11, { type: 'turn_start', step: 2 }),
      frame(12, { type: 'tool_execution_start', toolCallId: 'tc_same', toolName: 'search_logs', step: 2, arguments: { file: 'trace.log' } }),
      frame(13, { type: 'tool_execution_end', toolCallId: 'tc_same', toolName: 'search_logs', step: 2,
        durationMs: 1000, isError: false, preview: '已重试' }),
      frame(14, { type: 'message_update', deltaType: 'text_delta', messageId: 'msg_two', delta: '最终草稿' }),
    ];
    const beforeEnd = tail.reduce(applyRunEventEnvelope, active);
    expect(beforeEnd.streamText).toBe('检查完成\n\n最终草稿');
    expect(beforeEnd.toolCalls.map(({ status }) => status)).toEqual(['error', 'done']);
    expect(beforeEnd.highSignals).toMatchObject({
      firstError: { toolCallId: 'tc_same', step: 1, artifactId: 'art_fixture' },
      retryLoop: { toolCallId: 'tc_same', step: 2 },
      slowTool: { toolCallId: 'tc_same', step: 1 },
    });
    const ending = frame(15, { type: 'agent_end', status: 'completed', stopReason: 'completed', durationMs: 3000,
      finalAnswer: '清洗后的结论', conclusion });
    const terminal = applyRunEventEnvelope(beforeEnd, ending);
    expect(terminal).toMatchObject({
      run: { status: 'completed', durationMs: 3000 }, streamText: '清洗后的结论', activeTool: null, lastSeq: 15, conclusion,
    });
    expect(applyRunEventEnvelope(terminal, frame(16, { type: 'turn_start', step: 3 }))).toBe(terminal);
    expect(createRunTurnViewModel({ ...closedRun, finalAnswer: '落库结论' }, beginning).streamText).toBe('落库结论');
  });

  it('W2-02 从 inspect_trace 保留文件与行/步坐标并容忍截断预览', () => {
    const preview = JSON.stringify({
      file: 'part.log',
      anomalies: { firstError: { line: 42, snippet: 'error' },
        retryLoops: [{ toolName: 'get', startStep: 0, endStep: 2, repeatCount: 3 }],
        slowSpans: [{ step: 5, durationMs: 1200 }] },
    });
    const event = { type: 'tool_execution_end', toolCallId: 'tc_inspect', toolName: 'inspect_trace',
      step: 1, isError: false, durationMs: 5, preview } as const;
    const model = createRunTurnViewModel(run, [frame(1, event)]);
    expect(model.highSignals.firstError?.fileTarget).toEqual({ file: 'part.log', line: 42 });
    expect(model.highSignals.retryLoop?.fileTarget).toEqual({ file: 'part.log', step: 0 });
    expect(model.highSignals.slowTool?.fileTarget).toEqual({ file: 'part.log', step: 5 });
    expect(createRunTurnViewModel(run, [frame(1, { ...event, preview: preview.slice(0, 12) })]).highSignals)
      .toEqual({ firstError: null, retryLoop: null, slowTool: null });
  });

  it('按界面约定格式化时长、字节与状态', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDurationMs(1500)).toBe('1.5s');
    expect(formatDurationMs(999)).toBe('999ms');
    expect(formatRelativeTime(now, Date.parse(now) + 60_000)).toBe('1 分钟前');
    expect(formatRunStatus('failed')).toBe('执行失败');
    expect(formatRunStatus('stopped')).toBe('已停止');
    expect(formatStopReason('user_abort')).toBe('人工停止');
    expect(formatTaskOutcome('unknown')).toBe('未知');
  });
});
