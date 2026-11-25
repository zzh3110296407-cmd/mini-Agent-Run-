import {
  DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPRESSION_TRIGGER_RATIO, DEFAULT_INPUT_HARD_CAP_RATIO,
  buildDebugSystemPrompt, buildSessionHistoryMessages, createDebugContextTransform, estimateMessagesTokens,
  estimatePromptAndToolsTokens, estimateTokenCount, extractInvestigationConclusion, type PriorSessionRun,
} from '@mini-agent-run/debug-agent';
import {
  AgentMessageSchema, InvestigationConclusionSchema, type AgentMessage, type InvestigationConclusion, type ToolCallRequest,
} from '@mini-agent-run/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const at = '2026-11-25T00:00:00.000Z';
const later = '2026-11-25T00:00:01.000Z';
const loneSurrogate = /[\uD800-\uDFFF]/u;
const user = (name: string, content: string): AgentMessage => ({ id: 'msg_' + name, role: 'user', content, createdAt: at });
const assistant = (name: string, content = '', toolCalls: ToolCallRequest[] = []): AgentMessage => ({
  id: 'msg_' + name, role: 'assistant', content, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : 'stop', createdAt: at,
});
const call = (name: string, toolName = 'inspect_trace', args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id: 'tc_' + name, name: toolName, arguments: args });
const fixtureSummary = { summary: 'Conclusion fallback', evidence: [], recommendations: [] };

const exampleConclusion: InvestigationConclusion = {
  summary: 'The lookup failed before the final answer.',
  rootCauseStep: 2,
  rootCauseCategory: 'lookup',
  threeStateAssessment: { terminationReason: 'stop', hasToolError: true, taskOutcome: 'failed' },
  evidence: [
    { kind: 'file_step', label: 'Tool failed', file: 'trace.jsonl', step: 2 },
    { kind: 'file_line', label: 'Lookup failure', file: 'trace.log', startLine: 8, endLine: 9 },
    { kind: 'artifact_line', label: 'Search output', artifactId: 'art_demo', startLine: 1 },
  ],
  recommendations: ['Check the lookup inputs.'],
};
const backticks = String.fromCharCode(96).repeat(3);
const fence = (content: string, label = 'investigation-conclusion', marker = backticks, newline = '\n') =>
  [marker + label, content, marker].join(newline);
const conclusionFence = (conclusion: InvestigationConclusion = exampleConclusion) => fence(JSON.stringify(conclusion));

function toolTurn(tag: string, contents: readonly string[], assistantText = ''): AgentMessage[] {
  const calls = contents.map((_, index) => call(tag + '_' + index));
  return [
    assistant(tag, assistantText, calls),
    ...calls.map(({ id, name }, index): AgentMessage => ({
      id: 'msg_result_' + tag + '_' + index, role: 'toolResult', toolCallId: id, toolName: name,
      artifactId: 'art_' + tag + '_' + index, isError: index % 2 === 1, durationMs: 1,
      content: contents[index] ?? '', createdAt: at,
    })),
  ];
}

function prior(id: string, status: PriorSessionRun['status'], overrides: Partial<PriorSessionRun> = {}): PriorSessionRun {
  return {
    id: 'run_' + id, status, prompt: 'question ' + id, finalAnswer: 'answer ' + id, conclusion: null,
    createdAt: at, endedAt: later, ...overrides,
  };
}

function assertToolPairing(messages: readonly AgentMessage[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    expect(AgentMessageSchema.safeParse(message).success).toBe(true);
    if (message.role === 'toolResult') {
      expect(pending.delete(message.toolCallId)).toBe(true);
    } else {
      expect(pending.size).toBe(0);
      if (message.role === 'assistant') pending = new Set(message.toolCalls.map(({ id }) => id));
    }
  }
  expect(pending.size).toBe(0);
}

describe('[F05_MULTI_TURN_INVESTIGATION] session history and protocol-safe context budget', () => {
  it('uses the specified model window, token ratios and code-point estimator', () => {
    expect(DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS).toBe(1_048_576);
    expect(DEFAULT_COMPRESSION_TRIGGER_RATIO).toBe(0.55);
    expect(DEFAULT_INPUT_HARD_CAP_RATIO).toBe(0.70);
    expect(estimateTokenCount('abcde中🙂𠮷')).toBe(5);
    expect(estimateMessagesTokens([user('one', 'abcde中🙂𠮷')])).toBe(9);
    expect(estimateMessagesTokens([assistant('with_call', '', [call('one')])]))
      .toBeGreaterThan(estimateMessagesTokens([assistant('no_call')]));
    const definition = { name: 'inspect', description: 'Read a trace.', parameters: { type: 'object' } };
    expect(estimatePromptAndToolsTokens('中文', [])).toBe(6);
    expect(estimatePromptAndToolsTokens('中文', [definition])).toBeGreaterThan(6);
    expect(estimatePromptAndToolsTokens('', [])).toBe(0);
  });

  it('keeps only completed runs in chronological order and fills missing answers and ended times', () => {
    const input = [
      prior('new', 'completed', { createdAt: later, endedAt: null, finalAnswer: null, conclusion: fixtureSummary }),
      ...(['stopped', 'failed', 'pending', 'running'] as const).map((status) => prior(status, status)),
      prior('old', 'completed'),
      prior('empty', 'completed', { createdAt: '2026-11-25T00:00:02.000Z', finalAnswer: null }),
    ];
    const history = buildSessionHistoryMessages(input);
    expect(history.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'question old'], ['assistant', 'answer old'], ['user', 'question new'], ['assistant', 'Conclusion fallback'],
      ['user', 'question empty'], ['assistant', ''],
    ]);
    expect(history[1]).toMatchObject({ createdAt: later, toolCalls: [], stopReason: 'stop' });
    expect(history[3]).toMatchObject({ createdAt: later, toolCalls: [], stopReason: 'stop' });
    expect(new Set(history.map(({ id }) => id)).size).toBe(history.length);
    expect(history.every((message) => AgentMessageSchema.safeParse(message).success)).toBe(true);
    expect(input[0]?.id).toBe('run_new');
  });

  it('keeps messages unchanged below 55% and folds early results at exactly 55% including fixed overhead', async () => {
    const options = { contextWindowTokens: 1000 };
    const oldTool = toolTurn('old', ['中'.repeat(145), '🙂'.repeat(75)]);
    const recentTools = [...toolTurn('middle', ['recent text']), ...toolTurn('last', ['latest text'])];
    const input = [user('current', 'Look at the trace'), ...oldTool, ...recentTools];
    const overhead = 550 - estimateMessagesTokens(input);
    expect(overhead).toBeGreaterThan(0);
    const below = await createDebugContextTransform({ ...options, fixedOverheadTokens: overhead - 1 })(input);
    expect(below).not.toBe(input);
    expect(below.every((message, index) => message === input[index])).toBe(true);
    const exact = await createDebugContextTransform({ ...options, fixedOverheadTokens: overhead })(input);
    expect(exact[2]).toMatchObject({ toolCallId: 'tc_old_0', artifactId: 'art_old_0', content: expect.stringContaining('artifactId=art_old_0') });
    expect(exact[3]).toMatchObject({ toolCallId: 'tc_old_1', isError: true, content: expect.stringContaining('(error)') });
    expect(exact.slice(-recentTools.length)).toEqual(recentTools);
    expect(input[2]).toEqual(oldTool[1]);
    expect(estimateMessagesTokens(exact) + overhead).toBeLessThan(550);
    assertToolPairing(exact);
  });

  it('drops the earliest historical question, tool exchanges and answer as one unit', async () => {
    const oldest = [user('q1', '中'.repeat(180)), ...toolTurn('historical', ['中'.repeat(130)]), assistant('a1', 'old')];
    const newer = [user('q2', '中'.repeat(95)), assistant('a2', 'new')];
    const current = [user('latest', '中'.repeat(150)), ...toolTurn('latest_tool', ['observed evidence'])];
    const input = [...oldest, ...newer, ...current];
    expect(estimateMessagesTokens(input)).toBeGreaterThanOrEqual(550);
    expect(estimateMessagesTokens(input)).toBeLessThan(700);
    const result = await createDebugContextTransform({ contextWindowTokens: 1000 })(input);
    expect(result).toEqual([...newer, ...current]);
    assertToolPairing(result);
  });

  it('clips extreme contexts to 70% while keeping the current question and latest complete tool group', async () => {
    const input = [user('huge', '中🙂'.repeat(800) + '\uD800'),
      ...toolTurn('old_turn', ['旧'.repeat(1000)]),
      ...toolTurn('new_turn', ['新'.repeat(1200), '🙂'.repeat(1200)], '中'.repeat(400))];
    const result = await createDebugContextTransform({ contextWindowTokens: 1000, fixedOverheadTokens: 70 })(input);
    expect(result.map(({ id }) => id)).toEqual(['msg_huge', 'msg_new_turn', 'msg_result_new_turn_0', 'msg_result_new_turn_1']);
    expect(result[0]?.content.length).toBeGreaterThan(0);
    expect(result[0]?.content.length).toBeLessThan(input[0]?.content.length ?? 0);
    expect(result[2]?.content).toContain('artifactId=art_new_turn_0');
    expect(result[3]?.content).toContain('artifactId=art_new_turn_1');
    expect(result.every(({ content }) => !loneSurrogate.test(content))).toBe(true);
    expect(estimateMessagesTokens(result) + 70).toBeLessThanOrEqual(700);
    assertToolPairing(result);
  });

  it('rejects invalid budgets and a latest tool structure that cannot fit without losing pairing', () => {
    for (const settings of [
      { contextWindowTokens: 0 }, { triggerRatio: 0.8 }, { hardCapRatio: 1 },
      { fixedOverheadTokens: -1 }, { keepRecentToolTurns: 0.5 }, { contextWindowTokens: 1000, fixedOverheadTokens: 700 },
    ]) expect(() => createDebugContextTransform(settings)).toThrow(RangeError);
    const bigCall = call('big', 'inspect_trace', { query: '中'.repeat(1000) });
    const result = toolTurn('big', ['result'])[1];
    if (result?.role !== 'toolResult') throw new Error('Expected a tool result.');
    expect(() => createDebugContextTransform({ contextWindowTokens: 600 })([
      user('keep', 'current'), assistant('call', '', [bigCall]), { ...result, toolCallId: bigCall.id },
    ])).toThrow(RangeError);
  });

  it('preserves schemas, paired calls, Unicode and the hard cap across 100 seeded contexts', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 600, max: 4000 }), fc.integer({ min: 0, max: 70 }), fc.integer({ min: 0, max: 4 }),
      fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 4 }), fc.integer({ min: 1, max: 1100 }),
      fc.array(fc.array(fc.integer({ min: 1, max: 1200 }), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 }),
      async (contextWindowTokens, fixedOverheadTokens, keepRecentToolTurns, priorSizes, promptSize, turns) => {
        const history = priorSizes.flatMap((length, index) => [
          user('history' + index, '旧a'.repeat(length)), assistant('history_answer' + index, '🙂'.repeat(length)),
        ]);
        const current = user('current', '中a🙂'.repeat(promptSize));
        const input = [...history, current, ...turns.flatMap((sizes, index) =>
          toolTurn('turn' + index, sizes.map((size) => '日志🙂 '.repeat(size))))];
        const transformed = await createDebugContextTransform({ contextWindowTokens, fixedOverheadTokens, keepRecentToolTurns })(input);
        expect(transformed.some(({ id }) => id === current.id)).toBe(true);
        expect(transformed.some(({ id }) => id === 'msg_turn' + (turns.length - 1))).toBe(true);
        expect(estimateMessagesTokens(transformed) + fixedOverheadTokens).toBeLessThanOrEqual(Math.floor(contextWindowTokens * 0.70));
        expect(transformed.every(({ content }) => !loneSurrogate.test(content))).toBe(true);
        assertToolPairing(transformed);
      },
    ), { seed: 220205, numRuns: 100 });
  });
});

describe('[F05_MULTI_TURN_INVESTIGATION] debug prompt and tolerant conclusion extraction', () => {
  it('guides progressive evidence and three independent signals with safe target metadata', () => {
    const prompt = buildDebugSystemPrompt({ pathType: 'file', targetLabel: '演示 session.log', extraInstructions: 'Keep the answer concise.' });
    for (const name of ['list_files', 'inspect_trace', 'search_logs', 'read_file_slice', 'compare_files', 'read_artifact_slice',
      'terminationReason', 'hasToolError', 'taskOutcome', 'investigation-conclusion', 'file_step', 'file_line', 'artifact_line',
      'rootCauseStep', 'rootCauseCategory', 'threeStateAssessment', 'evidence', 'recommendations']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain('three independent signals');
    expect(prompt).toContain('演示 session.log');
    expect(prompt).toContain('target kind is file');
    expect(prompt).toContain('Keep the answer concise.');
    const privatePaths = ['D:\\User\\Private\\input.log', '/home/private/input.log', '\\\\internal\\evidence'];
    for (const path of privatePaths) {
      expect(buildDebugSystemPrompt({ pathType: 'dir', targetLabel: path, extraInstructions: 'Read from ' + path }))
        .toBe(buildDebugSystemPrompt({ pathType: 'dir' }));
    }
    const privateToken = ['sk', 'fixture-0123456789'].join('-');
    expect(buildDebugSystemPrompt({ targetLabel: privateToken, extraInstructions: 'Authorization: Bearer ' + privateToken }))
      .toBe(buildDebugSystemPrompt());
  });

  it('extracts all evidence types from a case-insensitive tilde fence and cleans only that block', () => {
    const selected = fence(JSON.stringify(exampleConclusion), '  INVESTIGATION-CONCLUSION  ', '~~~', '\r\n');
    const example = fence('{"foo":1}', 'json', backticks, '\r\n');
    const raw = ['Human answer', '', selected, '', '', '', example, 'Tail'].join('\r\n');
    expect(extractInvestigationConclusion(raw)).toEqual({
      conclusion: exampleConclusion, cleanedAnswer: ['Human answer', '', example, 'Tail'].join('\r\n'),
    });
  });

  it('chooses the last valid dedicated block and uses its summary for a block-only answer', () => {
    const earlier = conclusionFence({ ...exampleConclusion, summary: 'Earlier summary' });
    const selected = conclusionFence();
    const malformed = fence('{broken');
    expect(extractInvestigationConclusion([earlier, selected, malformed].join('\n\n'))).toEqual({
      conclusion: exampleConclusion, cleanedAnswer: [earlier, malformed].join('\n\n'),
    });
    expect(extractInvestigationConclusion(selected)).toEqual({ conclusion: exampleConclusion, cleanedAnswer: exampleConclusion.summary });
  });

  it('uses the last JSON fence as a fallback only when it passes the conclusion schema', () => {
    const valid = fence(JSON.stringify(exampleConclusion), 'json');
    const invalid = fence('{"foo":1}', 'JSON');
    const badDedicated = fence('{bad');
    expect(extractInvestigationConclusion([badDedicated, invalid, valid].join('\n'))).toEqual({
      conclusion: exampleConclusion, cleanedAnswer: [badDedicated, invalid].join('\n'),
    });
    const earlierValid = valid + '\n' + invalid;
    expect(extractInvestigationConclusion(earlierValid)).toEqual({ conclusion: null, cleanedAnswer: earlierValid });
  });

  it('keeps malformed, incomplete, non-conclusion and nested fences unchanged', () => {
    const invalidEvidence = { ...exampleConclusion, evidence: [{ kind: 'file_line', label: 'Wrong order',
      file: 'trace.log', startLine: 10, endLine: 9 }] };
    for (const answer of [
      '  plain answer \r\n',
      fence('{"foo": 1}', 'json'),
      fence('{not JSON'),
      fence(JSON.stringify(invalidEvidence)),
      backticks + 'investigation-conclusion\n{"summary":"missing',
      fence(conclusionFence(), 'text', '~~~~'),
      fence(JSON.stringify(exampleConclusion), 'investigation-conclusion') + '~',
    ]) {
      expect(extractInvestigationConclusion(answer)).toEqual({ conclusion: null, cleanedAnswer: answer });
    }
  });

  it('handles 100 seeded mixtures of random text, JSON, and complete or partial fences', () => {
    const snippet = fc.oneof(fc.string({ maxLength: 30 }), fc.json(), fc.constantFrom(
      backticks, '~~~JSON', backticks + 'investigation-conclusion\n{', conclusionFence(), '<missing end>',
    ));
    fc.assert(fc.property(fc.array(snippet, { maxLength: 10 }), (parts) => {
      const raw = parts.join('\n');
      const { conclusion, cleanedAnswer } = extractInvestigationConclusion(raw);
      if (conclusion) {
        expect(InvestigationConclusionSchema.safeParse(conclusion).success).toBe(true);
        expect(cleanedAnswer.trim()).not.toBe('');
      } else {
        expect(cleanedAnswer).toBe(raw);
      }
    }), { seed: 220207, numRuns: 100 });
  });
});
