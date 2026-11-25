import type { AgentTool, ArtifactStorePort, SaveArtifactInput, TraceWorkspacePort } from '@mini-agent-run/agent';
import { createMockLLMProvider, LLMProviderError } from '@mini-agent-run/ai';
import {
  DEEPSEEK_FLASH_CONTEXT_WINDOW_TOKENS, DEFAULT_COMPRESSION_TRIGGER_RATIO, DEFAULT_INPUT_HARD_CAP_RATIO,
  buildDebugSystemPrompt, buildSessionHistoryMessages, createDebugAgent, createDebugContextTransform, estimateMessagesTokens,
  estimatePromptAndToolsTokens, estimateTokenCount, extractInvestigationConclusion, runDebugInvestigation,
  type DebugAgentConfig, type DebugInvestigationInput, type PriorSessionRun,
} from '@mini-agent-run/debug-agent';
import {
  AgentEventSchema, AgentMessageSchema, AgentStateSchema, ArtifactMetaSchema, InvestigationConclusionSchema,
  MAX_INLINE_TOOL_OUTPUT_BYTES, type AgentEvent, type AgentMessage, type ArtifactMeta, type InvestigationConclusion,
  type ToolCallRequest,
} from '@mini-agent-run/shared';
import { classifyTraceLine, createToolRegistry, summarizeToolOutput } from '@mini-agent-run/tools';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

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

function tightBudgetFixture() {
  const systemPrompt = '离线复核。';
  const prompt = '排查原因。';
  const shortened = '排查原因';
  const tool = {
    name: 'lookup', description: 'Find a trace record.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute: vi.fn(async () => ({ isError: false, content: 'OK' })),
  };
  const lookup = call('ping', 'lookup', { query: '' });
  const witness: AgentMessage[] = [
    user('budget_question', shortened),
    assistant('budget_latest', '', [lookup]),
    { id: 'msg_budget_result', role: 'toolResult', toolCallId: lookup.id, toolName: lookup.name,
      isError: false, durationMs: 0, content: 'OK', createdAt: at },
  ];
  const fixedOverheadTokens = estimatePromptAndToolsTokens(systemPrompt, [tool]);
  lookup.arguments.query = '核'.repeat(420 - fixedOverheadTokens - estimateMessagesTokens(witness));
  expect(fixedOverheadTokens).toBe(55);
  expect(fixedOverheadTokens + estimateMessagesTokens(witness)).toBe(420);
  const input = [user('budget_question', prompt), ...witness.slice(1)];
  return { systemPrompt, prompt, shortened, tool, lookup, witness, input, fixedOverheadTokens };
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

  it.each([false, true])('fits a short tool result at the 420-token hard cap (older history: %s)', async (withHistory) => {
    const { input, witness, fixedOverheadTokens } = tightBudgetFixture();
    expect(fixedOverheadTokens + estimateMessagesTokens(input)).toBe(421);
    const messages = withHistory
      ? [user('previous_q', 'Earlier question'), assistant('previous_a', 'Earlier answer'),
        ...input.slice(0, 1), ...toolTurn('earlier_step', ['已核对'.repeat(100)]), ...input.slice(1)]
      : input;
    const output = await createDebugContextTransform({ contextWindowTokens: 600, fixedOverheadTokens })(messages);
    expect(output).toEqual(witness);
    expect(fixedOverheadTokens + estimateMessagesTokens(output)).toBe(420);
    expect(input[0]?.content).toBe('排查原因。');
    assertToolPairing(output);
  });

  it('retains the exact Artifact ID when folding a short result with a longer lookalike in its body', async () => {
    const artifactId = 'art_trace_3-';
    const [toolCall, result] = toolTurn('pointer', ['OK ' + artifactId + 'extra']);
    if (!toolCall || result?.role !== 'toolResult') throw new Error('Expected a complete tool turn.');
    const input = [user('artifact_question', '中'.repeat(160)), toolCall, { ...result, artifactId }];
    const output = await createDebugContextTransform({
      contextWindowTokens: 250, keepRecentToolTurns: 0,
    })(input);
    expect(output[2]).toMatchObject({ artifactId, content: 'artifactId=' + artifactId });
    expect(estimateMessagesTokens(output)).toBeLessThanOrEqual(175);
    assertToolPairing(output);
  });

  it('tries compact Artifact pointers when the retained tool bodies leave no room for the question', async () => {
    const turn = toolTurn('tight_pointers', [
      'Saved matching trace lines; artifactId=art_tight_pointers_0',
      'Saved matching trace lines; artifactId=art_tight_pointers_1',
    ]);
    const input = [user('limited_question', '请定位'), ...turn];
    const fixedOverheadTokens = 420 - estimateMessagesTokens([user('limited_question', ''), ...turn]);
    const output = await createDebugContextTransform({ contextWindowTokens: 600, fixedOverheadTokens })(input);
    expect(output[0]).toEqual(input[0]);
    expect(output[1]).toEqual(input[1]);
    expect(output[2]).toMatchObject({ content: 'artifactId=art_tight_pointers_0', artifactId: 'art_tight_pointers_0' });
    expect(output[3]).toEqual(input[3]);
    expect(fixedOverheadTokens + estimateMessagesTokens(output)).toBeLessThanOrEqual(420);
    assertToolPairing(output);
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

  it.each([['LF', '\n'], ['CRLF', '\r\n']])('preserves literal log line numbers in %s fences around the selected conclusion', (_style, newline) => {
    const log = ['  ~~~text', 'BEGIN  ', '', '', 'END', '  ~~~'].join(newline);
    const secondary = [backticks + 'log', 'A', '  ', '\t', 'B', backticks].join(newline);
    const title = 'Trace excerpt. END is on line 4.';
    const after = 'Second excerpt.';
    const answer = [
      '', title, '', '', log, '', '',
      fence(JSON.stringify(exampleConclusion), 'investigation-conclusion', '~~~', newline),
      '', '', after, '', '', secondary, '', '',
    ].join(newline);
    const output = extractInvestigationConclusion(answer);
    expect(output).toEqual({
      conclusion: exampleConclusion,
      cleanedAnswer: [title, '', log, '', after, '', secondary].join(newline),
    });
    const displayed = output.cleanedAnswer.split(newline);
    expect(displayed.indexOf('END') - displayed.indexOf('BEGIN  ') + 1).toBe(4);
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

function sliceContent(content: string, { offsetLine, limit, level, q }: Parameters<TraceWorkspacePort['sliceText']>[1]) {
  const lines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const matches = lines.map((text, index) => ({ lineNumber: index + 1, level: classifyTraceLine(text), text }))
    .filter((line) => (level === undefined || line.level === level) && (q === undefined || line.text.includes(q)));
  const eligible = matches.filter(({ lineNumber }) => lineNumber >= offsetLine);
  const nextOffsetLine = eligible[limit]?.lineNumber ?? null;
  return {
    totalLines: lines.length, matchedLines: matches.length, offsetLine, limit,
    hasMore: nextOffsetLine !== null, nextOffsetLine, lines: eligible.slice(0, limit),
  };
}

function debugFixture() {
  const targetPath = 'D:\\private\\case-data';
  const file = 'trace.log';
  const content = Array.from({ length: 64 }, (_, index) => 'INFO Request ' + index + ' ' + 'diagnostic detail '.repeat(10))
    .join('\n') + '\nERROR root cause: missing lookup argument';
  const workspace: TraceWorkspacePort = {
    binding: { targetPath, pathType: 'dir' },
    resolveTarget: () => ({ realPath: targetPath, kind: 'dir' }),
    listFiles: () => ({ entries: [{ relativePath: file, kind: 'file', byteSize: Buffer.byteLength(content), modifiedAt: at }],
      truncated: false }),
    readFile(relativePath) {
      if (relativePath !== file) throw Object.assign(new Error('No fixture for this file.'), { code: 'PATH_NOT_FOUND' });
      return { relativePath, byteSize: Buffer.byteLength(content), content };
    },
    sliceText: sliceContent,
  };
  const artifacts = new Map<string, { content: string; metadata: ArtifactMeta }>();
  const save = vi.fn(({ content: original, ...input }: SaveArtifactInput) => {
    const metadata = ArtifactMetaSchema.parse({
      ...input, id: 'art_memory_' + artifacts.size, byteSize: Buffer.byteLength(original),
      lineCount: input.summary.lineCount, createdAt: at,
    });
    artifacts.set(metadata.id, { content: original, metadata });
    return metadata;
  });
  const readSlice = vi.fn<ArtifactStorePort['readSlice']>((id, { query, ...page }) => {
    const stored = artifacts.get(id);
    return stored ? sliceContent(stored.content, { ...page, q: query }) : null;
  });
  const artifactStore: ArtifactStorePort = { save, readSlice, getMeta: (id) => artifacts.get(id)?.metadata ?? null };
  const tools = createToolRegistry({ workspace, artifactStore, toolMode: 'mock' });
  const input: DebugInvestigationInput = {
    runId: 'run_debug_first', sessionId: 'ses_debug', prompt: 'Why did the run fail?',
    targetPath, pathType: 'dir', targetLabel: 'diagnostic run', allowedRoots: [targetPath],
    toolMode: 'mock', artifactStore, signal: new AbortController().signal,
  };
  return { tools, save, readSlice, input };
}

describe('[F05_MULTI_TURN_INVESTIGATION] offline debug investigations', () => {
  it('makes the second model request when a short result leaves the context one token over budget', async () => {
    const { systemPrompt, prompt, shortened, lookup, tool } = tightBudgetFixture();
    const fixture = debugFixture();
    const provider = createMockLLMProvider({ turns: [{ toolCalls: [lookup] }, { text: 'Done.' }] });
    const result = await runDebugInvestigation({
      ...fixture.input, systemPrompt, prompt, tools: [tool], provider, model: 'fixture', contextWindowTokens: 600,
    });
    expect(result).toMatchObject({ state: { status: 'completed', step: 2 }, finalAnswer: 'Done.', conclusion: null });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(provider.recordedRequests).toHaveLength(2);
    expect(provider.recordedRequests[1]?.messages).toEqual([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: shortened },
      { role: 'assistant', content: '', toolCalls: [lookup] },
      { role: 'tool', content: 'OK', name: lookup.name, toolCallId: lookup.id },
    ]);
  });

  it.each([false, true])('reads evidence from a short Artifact result after compression (ID already in body: %s)', async (bodyIncludesId) => {
    const { tools, save, readSlice, input } = debugFixture();
    const reader = tools.find(({ name }) => name === 'read_artifact_slice');
    if (!reader) throw new Error('Expected the real Artifact reader.');
    const evidence = 'First line of preserved evidence.';
    const capture: AgentTool = {
      name: 'capture_log', description: 'Save a trace excerpt.', parameters: { type: 'object' },
      async execute(_args, context) {
        if (!context.toolCallId) throw new Error('Expected a tool call ID.');
        const { id } = await context.artifactStore.save({
          runId: context.runId, sessionId: context.sessionId, toolCallId: context.toolCallId,
          sourceTool: 'capture_log', title: 'Excerpt', contentType: 'text/plain',
          content: evidence, summary: summarizeToolOutput(evidence),
        });
        return { artifactId: id, content: bodyIncludesId ? 'OK ' + id : 'OK', isError: false };
      },
    };
    const captureCall = call('capture', capture.name);
    const provider = createMockLLMProvider({ turns: (request, index) => {
      if (index === 0) return { toolCalls: [captureCall] };
      if (index === 1) {
        const wire = request.messages.find((message) => message.role === 'tool' && message.toolCallId === captureCall.id);
        const artifactId = /\bart_[A-Za-z0-9_-]+/.exec(wire?.content ?? '')?.[0];
        if (!artifactId) return { text: 'Missing Artifact ID.' };
        return { toolCalls: [call('read', reader.name, { artifactId, startLine: 1, limit: 1 })] };
      }
      return { text: 'Read finished.' };
    } });
    const systemPrompt = 'Inspect the trace.';
    const prompt = '定位问题。'.repeat(84);
    const available = [capture, reader];
    const overhead = estimatePromptAndToolsTokens(systemPrompt, available);
    const firstRequestTokens = overhead + estimateMessagesTokens([user('start', prompt)]);
    const contextWindowTokens = Math.ceil((firstRequestTokens + 7) / DEFAULT_INPUT_HARD_CAP_RATIO);
    const hardCap = Math.floor(contextWindowTokens * DEFAULT_INPUT_HARD_CAP_RATIO);
    const result = await runDebugInvestigation({
      ...input, prompt, systemPrompt, tools: available, provider, model: 'fixture', contextWindowTokens,
    });
    expect(result.state.status).toBe('completed');
    expect(result.finalAnswer).toBe('Read finished.');
    expect(overhead + estimateMessagesTokens(result.state.messages.slice(0, 3))).toBeGreaterThan(hardCap);
    expect(result.state.messages[2]?.content).toBe(bodyIncludesId ? 'OK art_memory_0' : 'OK');
    const compressed = provider.recordedRequests[1]?.messages;
    expect(compressed?.[2]).toMatchObject({ role: 'assistant', toolCalls: [captureCall] });
    expect(compressed?.[3]).toEqual({
      role: 'tool', name: capture.name, toolCallId: captureCall.id,
      content: bodyIncludesId ? 'OK art_memory_0' : 'artifactId=art_memory_0',
    });
    const projectedCost = compressed?.slice(1).reduce((sum, message) => sum + 4 + estimateTokenCount(message.content)
      + (message.role === 'assistant' && message.toolCalls?.length ? estimateTokenCount(JSON.stringify(message.toolCalls)) : 0), overhead);
    expect(projectedCost).toBeLessThanOrEqual(hardCap);
    expect(save).toHaveBeenCalledOnce();
    expect(readSlice).toHaveBeenCalledExactlyOnceWith('art_memory_0', { offsetLine: 1, limit: 1, level: undefined, query: undefined });
    const readback = result.state.messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'tc_read');
    expect(JSON.parse(readback?.content ?? '')).toMatchObject({ lines: [{ lineNumber: 1, text: evidence }] });
  });

  it.each(['metadata-only', 'already-in-body', 'auto-offload'] as const)(
    'uses a complete Artifact pointer and reads the saved log at exactly 420 tokens (%s)', async (mode) => {
      const { tools, save, readSlice, input } = debugFixture();
      const reader = tools.find(({ name }) => name === 'read_artifact_slice');
      if (!reader) throw new Error('Expected the real Artifact reader.');
      const firstLine = 'INFO captured evidence from step 1.';
      const evidence = Array.from({ length: 210 }, () => firstLine).join('\n');
      expect(Buffer.byteLength(evidence)).toBe(7559);
      const capture: AgentTool = {
        name: 'capture_log', description: 'Save the matched trace lines.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        async execute(_args, context) {
          if (mode === 'auto-offload') return { content: evidence, isError: false };
          if (!context.toolCallId) throw new Error('Expected a tool call ID.');
          const { id } = await context.artifactStore.save({
            runId: context.runId, sessionId: context.sessionId, toolCallId: context.toolCallId,
            sourceTool: 'capture_log', title: 'Trace', contentType: 'text/plain',
            content: evidence, summary: summarizeToolOutput(evidence),
          });
          const content = mode === 'metadata-only' ? 'OK' : 'Saved matching trace lines; artifactId=' + id;
          return { artifactId: id, content, isError: false };
        },
      };
      const systemPrompt = 'Inspect the trace.';
      const available = [capture, reader];
      const overhead = estimatePromptAndToolsTokens(systemPrompt, available);
      const artifactId = 'art_memory_0';
      const pointer = 'artifactId=' + artifactId;
      const captureCall = call('capture', capture.name, { query: '' });
      const witness: AgentMessage[] = [
        user('tight_question', '请定位'),
        assistant('tight_call', '', [captureCall]),
        { id: 'msg_tight_result', role: 'toolResult', toolCallId: captureCall.id, toolName: capture.name,
          artifactId, content: pointer, isError: false, durationMs: 0, createdAt: at },
      ];
      const remaining = 420 - overhead - estimateMessagesTokens(witness);
      expect(remaining).toBeGreaterThan(0);
      captureCall.arguments.query = '核'.repeat(remaining);
      expect(overhead + estimateMessagesTokens(witness)).toBe(420);
      const provider = createMockLLMProvider({ turns: (request, index) => {
        if (index === 0) return { toolCalls: [captureCall] };
        if (index === 1) {
          const body = request.messages.find((message) => message.role === 'tool' && message.toolCallId === captureCall.id)?.content;
          const id = /\bart_[A-Za-z0-9_-]+/.exec(body ?? '')?.[0];
          return id ? { toolCalls: [call('read', reader.name, { artifactId: id, startLine: 1, limit: 1 })] }
            : { text: 'Missing Artifact ID.' };
        }
        return { text: 'Done.' };
      } });
      const result = await runDebugInvestigation({
        ...input, prompt: '请定位原因并引用这条记录。', systemPrompt, tools: available, provider,
        model: 'fixture', contextWindowTokens: 600, maxSteps: 3,
      });
      expect(result).toMatchObject({ state: { status: 'completed', step: 3 }, finalAnswer: 'Done.' });
      expect(provider.recordedRequests).toHaveLength(3);
      expect(provider.recordedRequests[1]?.messages).toEqual([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请定位' },
        { role: 'assistant', content: '', toolCalls: [captureCall] },
        { role: 'tool', content: pointer, name: capture.name, toolCallId: captureCall.id },
      ]);
      expect(overhead + estimateMessagesTokens(result.state.messages.slice(0, 3))).toBeGreaterThan(420);
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].content).toBe(evidence);
      const rawToolBody = result.state.messages[2]?.content ?? '';
      if (mode === 'auto-offload') expect(JSON.parse(rawToolBody)).toMatchObject({ artifactId, truncatedForLlm: true });
      else expect(Buffer.byteLength(rawToolBody)).toBe(mode === 'metadata-only' ? 2 : 51);
      expect(readSlice).toHaveBeenCalledExactlyOnceWith(artifactId, { offsetLine: 1, limit: 1, level: undefined, query: undefined });
      const readback = result.state.messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'tc_read');
      expect(JSON.parse(readback?.content ?? '')).toMatchObject({ lines: [{ lineNumber: 1, text: firstLine }] });
    },
  );

  it('runs real tools, offloads a large search result, reads the Artifact and answers with a structured conclusion', async () => {
    const { tools, save, readSlice, input } = debugFixture();
    const artifactId = 'art_memory_0';
    const rawAnswer = 'The lookup had a missing argument.\n\n' + conclusionFence({
      ...exampleConclusion, evidence: [{ kind: 'artifact_line', label: 'Recovered log matches', artifactId, startLine: 1 }],
    });
    const provider = createMockLLMProvider({ turns: [
      { toolCalls: [call('list', 'list_files'), call('inspect', 'inspect_trace', { file: 'trace.log' })] },
      { toolCalls: [call('search', 'search_logs', { file: 'trace.log', query: 'INFO' })] },
      { toolCalls: [call('read', 'read_artifact_slice', { artifactId, startLine: 1, limit: 1 })] },
      { text: rawAnswer, chunkSize: 80 },
      { text: 'Follow-up answer.' },
    ] });
    const events: AgentEvent[] = [];
    const config: DebugAgentConfig = { provider, tools, model: 'deepseek-flash', providerName: 'fixture-gateway' };
    const agent = createDebugAgent(config);
    expect(agent.config).toBe(config);
    const result = await agent.investigate({ ...input, onEvent: async (value) => {
      await Promise.resolve();
      events.push(AgentEventSchema.parse(value));
    } });
    expect(result).toMatchObject({
      state: { status: 'completed', step: 4, pendingToolCalls: [], model: { modelId: 'deepseek-flash', provider: 'fixture-gateway' } },
      finalAnswer: 'The lookup had a missing argument.',
      conclusion: { evidence: [{ kind: 'artifact_line', artifactId, startLine: 1 }] },
    });
    expect(AgentStateSchema.safeParse(result.state).success).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', finalAnswer: result.finalAnswer, conclusion: result.conclusion });
    expect(result.state.messages.at(-1)?.content).toBe(rawAnswer);
    expect(provider.recordedRequests[0]?.tools?.map(({ name }) => name)).toEqual(tools.map(({ name }) => name));
    expect(provider.recordedRequests[0]?.tools).toHaveLength(7);
    expect(provider.recordedRequests[0]?.messages[0]?.content).toContain('diagnostic run');
    expect(provider.recordedRequests[0]?.messages[0]?.content).not.toContain(input.targetPath);
    expect(save).toHaveBeenCalledOnce();
    const stored = save.mock.calls[0]?.[0];
    expect(stored).toMatchObject({ sourceTool: 'search_logs', toolCallId: 'tc_search', runId: input.runId, sessionId: input.sessionId });
    expect(Buffer.byteLength(stored?.content ?? '')).toBeGreaterThan(MAX_INLINE_TOOL_OUTPUT_BYTES);
    expect(JSON.parse(stored?.content ?? '')).toMatchObject({ totalMatches: 64, matches: expect.any(Array) });
    const summary = provider.recordedRequests[2]?.messages.find((message) => message.role === 'tool' && message.toolCallId === 'tc_search');
    expect(Buffer.byteLength(summary?.content ?? '')).toBeLessThanOrEqual(MAX_INLINE_TOOL_OUTPUT_BYTES);
    expect(JSON.parse(summary?.content ?? '')).toMatchObject({ artifactId, truncatedForLlm: true });
    expect(readSlice).toHaveBeenCalledExactlyOnceWith(artifactId, { offsetLine: 1, limit: 1, level: undefined, query: undefined });
    const reread = provider.recordedRequests[3]?.messages.find((message) => message.role === 'tool' && message.toolCallId === 'tc_read');
    expect(Buffer.byteLength(reread?.content ?? '')).toBeLessThanOrEqual(MAX_INLINE_TOOL_OUTPUT_BYTES);
    const readback = JSON.parse(reread?.content ?? '');
    expect(readback).toMatchObject({ lineTruncated: true, lines: [{ lineNumber: 1 }] });
    expect(readback.lines[0].text).toContain('INFO Request 0');
    expect(stored?.content.startsWith(readback.lines[0].text)).toBe(true);

    const followUp = await agent.investigate({
      ...input, runId: 'run_debug_next', prompt: 'How can it be prevented?',
      priorRuns: [
        prior('failed', 'failed', { prompt: 'failed-history-only' }),
        prior('foreign', 'completed', { sessionId: 'ses_other', prompt: 'foreign-history-only' }),
        prior('debug_first', 'completed', { sessionId: input.sessionId, prompt: input.prompt,
          finalAnswer: result.finalAnswer, conclusion: result.conclusion }),
      ],
    });
    expect(followUp).toMatchObject({ finalAnswer: 'Follow-up answer.', conclusion: null });
    expect(provider.recordedRequests[4]?.messages.slice(1)).toEqual([
      { role: 'user', content: input.prompt }, { role: 'assistant', content: result.finalAnswer },
      { role: 'user', content: 'How can it be prevented?' },
    ]);
  });

  it('applies a custom context transform before the hard cap and counts system and tool overhead', async () => {
    const fixture = debugFixture();
    const tools = fixture.tools.slice(0, 1);
    const systemPrompt = '保留事实'.repeat(15);
    const provider = createMockLLMProvider({ turns: [{ text: 'Answer' }] });
    const transformContext = vi.fn(async (messages: readonly AgentMessage[]) =>
      messages.map((message) => ({ ...message, content: '中'.repeat(1400) })));
    const result = await runDebugInvestigation({
      ...fixture.input, tools, model: 'mock-model', provider, systemPrompt, transformContext, contextWindowTokens: 1000,
    });
    const projected = provider.recordedRequests[0]?.messages;
    expect(projected?.[0]).toEqual({ role: 'system', content: systemPrompt });
    const content = projected?.[1]?.content ?? '';
    const remaining = 700 - estimatePromptAndToolsTokens(systemPrompt, tools) - 4;
    expect(remaining).toBeGreaterThan(0);
    expect(content).toBe('中'.repeat(remaining));
    expect(result.state.messages[0]?.content).toBe(fixture.input.prompt);
    expect(transformContext).toHaveBeenCalledOnce();
  });

  it('aborts in-flight diagnostics and emits a stopped terminal event with no conclusion', async () => {
    const { tools, input, save } = debugFixture();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const provider = createMockLLMProvider({ turns: [{
      toolCalls: [call('slow', 'check_runtime_diagnostics', { scenario: 'slow', delayMs: 20, progressIntervalMs: 5 })],
    }] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await runDebugInvestigation({
        ...input, provider, model: 'mock-model', tools, signal: controller.signal,
        onEvent(event) {
          events.push(event);
          if (event.type === 'tool_execution_start') timer = setTimeout(() => controller.abort(), 5);
        },
      });
      expect(result).toMatchObject({
        conclusion: null, finalAnswer: null, state: { status: 'stopped', stopReason: 'user_abort', pendingToolCalls: [] },
      });
      expect(events.at(-2)).toMatchObject({ type: 'tool_execution_end', toolCallId: 'tc_slow', isError: true });
      expect(events.at(-1)).toMatchObject({ type: 'agent_end', status: 'stopped', stopReason: 'user_abort' });
      expect(events.at(-1)).not.toHaveProperty('conclusion');
      expect(provider.recordedRequests).toHaveLength(1);
      expect(save).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
    }
  });

  it('keeps conclusions unset for model errors and for answers from runs stopped by the step budget', async () => {
    const fixture = debugFixture();
    const events: AgentEvent[] = [];
    const raw = conclusionFence();
    const stopping = createMockLLMProvider({ turns: [{ text: raw, toolCalls: [call('list', 'list_files')] }] });
    const error = createMockLLMProvider({ turns: [{ error: new LLMProviderError('LLM_AUTH_ERROR', 'Denied') }] });
    const base = { ...fixture.input, tools: fixture.tools, model: 'mock-model', maxSteps: 1,
      onEvent: (event: AgentEvent) => { events.push(event); } };
    const stopped = await runDebugInvestigation({ ...base, provider: stopping });
    expect(stopped).toMatchObject({ conclusion: null, finalAnswer: raw, state: { status: 'stopped', stopReason: 'max_steps' } });
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', finalAnswer: raw });
    expect(events.at(-1)).not.toHaveProperty('conclusion');
    const failed = await runDebugInvestigation({ ...base, provider: error });
    expect(failed).toMatchObject({ conclusion: null, finalAnswer: null, state: { status: 'failed', stopReason: 'error' } });
    expect(events.at(-1)).not.toHaveProperty('conclusion');
  });

  it('validates the configured artifact budget via the existing offload wrapper', async () => {
    const fixture = debugFixture();
    const provider = createMockLLMProvider({ turns: [{ text: 'Unused' }] });
    await expect(runDebugInvestigation({
      ...fixture.input, tools: fixture.tools, provider, model: 'mock-model', maxInlineToolBytes: 6145,
    })).rejects.toThrow(RangeError);
    expect(provider.recordedRequests).toEqual([]);
  });
});
