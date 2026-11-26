import type { ArtifactStorePort, ToolExecutionContext, TraceWorkspacePort } from '@mini-agent-run/agent';
import {
  AgentMessageSchema, ArtifactMetaSchema, TextSliceResponseSchema, TraceOverviewSchema, type TextSliceResponse,
} from '@mini-agent-run/shared';
import { analyzeTraceContent, createToolRegistry, createTraceLineClassifier, sanitizeTraceContent, truncateUtf8Safe } from '@mini-agent-run/tools';
import fc from 'fast-check';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';

const fileNames = ['list_files', 'inspect_trace', 'read_file_slice', 'search_logs', 'read_artifact_slice',
  'compare_files', 'check_runtime_diagnostics'];
const iso = '2026-11-25T00:00:00.000Z';
const targetPath = '/fixture';
const charLimit = 6144;

function page(lines: TextSliceResponse['lines'], nextOffsetLine: number | null = null): TextSliceResponse {
  return { totalLines: lines.length, matchedLines: lines.length, offsetLine: 1, limit: 200,
    hasMore: nextOffsetLine !== null, nextOffsetLine, lines };
}

function artifactMeta(sessionId: string) {
  return ArtifactMetaSchema.parse({
    id: 'art_one', sessionId, runId: 'run_one', toolCallId: 'tc_one', sourceTool: 'search_logs', title: 'Trace output',
    contentType: 'text/plain', byteSize: 42, lineCount: 3, createdAt: iso,
    summary: {
      byteSize: 42, lineCount: 3, truncatedForLlm: true,
      levelCounts: { error: 0, warn: 0, info: 3, other: 0 }, firstErrorLine: null, previewHead: 'trace output',
    },
  });
}

function build(fixtures: Record<string, string> = {}, options: {
  store?: ArtifactStorePort; onRead?: () => void; file?: string;
} = {}) {
  const artifactStore: ArtifactStorePort = options.store ?? {
    save: () => { throw new Error('Not needed'); }, getMeta: () => null, readSlice: () => null,
  };
  const bound = options.file ?? targetPath;
  const pathType = options.file === undefined ? 'dir' : 'file';
  const workspace: TraceWorkspacePort = {
    binding: { targetPath: bound, pathType },
    resolveTarget: vi.fn(() => ({ realPath: bound, kind: pathType })),
    listFiles: vi.fn(() => ({
      entries: Object.keys(fixtures).sort().map((relativePath) => ({
        relativePath, kind: 'file' as const, byteSize: Buffer.byteLength(fixtures[relativePath] ?? ''), modifiedAt: iso,
      })),
      truncated: false,
    })),
    readFile: vi.fn((filename) => {
      options.onRead?.();
      const relativePath = filename ?? options.file ?? '';
      const content = fixtures[relativePath];
      if (content === undefined) throw Object.assign(new Error('private filesystem detail'), { code: 'PATH_NOT_FOUND' });
      return { relativePath, content, byteSize: Buffer.byteLength(content) };
    }),
    sliceText: vi.fn((content, { offsetLine, limit, level, q }) => {
      const rows = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
      const valid = rows.map((text, index) => ({
        text, lineNumber: index + 1, level: /\bERROR\b/.test(text) ? 'error' as const : 'info' as const,
      })).filter((row) => (level === undefined || row.level === level) && (!q || row.text.toLowerCase().includes(q.toLowerCase())));
      const candidates = valid.filter((row) => row.lineNumber >= offsetLine);
      const nextOffsetLine = candidates[limit]?.lineNumber ?? null;
      return { totalLines: rows.length, matchedLines: valid.length, offsetLine, limit,
        lines: candidates.slice(0, limit), nextOffsetLine, hasMore: nextOffsetLine !== null };
    }),
  };
  const tools = createToolRegistry({ workspace, toolMode: 'mock', artifactStore });
  const ctx: ToolExecutionContext = {
    sessionId: 'ses_one', runId: 'run_one', targetPath: bound, allowedRoots: ['/fixture'],
    toolMode: 'mock', artifactStore, signal: new AbortController().signal,
  };
  async function call(name: string, args: Record<string, unknown> = {}, context: Partial<ToolExecutionContext> = {}) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error('Unregistered tool: ' + name);
    const result = await tool.execute(args, { ...ctx, ...context });
    return { ...result, data: JSON.parse(result.content) };
  }
  return { workspace, tools, call };
}

function expectError(result: { isError: boolean; data: unknown }, code: string) {
  expect(result.isError).toBe(true);
  expect(result.data).toEqual({ error: { code, message: expect.any(String) } });
}

function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

describe('[F03_PATH_SCOPED_TOOLS] trace analysis and workspace tools', () => {
  it('registers all seven tools with object schemas and validates inputs and the session binding', async () => {
    const { tools, workspace, call } = build({ 'trace.json': '{}' });
    expect(tools.map(({ name }) => name)).toEqual(fileNames);
    for (const { description, parameters } of tools) {
      expect(description).toBeTruthy();
      expect(parameters).toMatchObject({ type: 'object', properties: expect.any(Object), additionalProperties: false });
    }
    expect(tools.find(({ name }) => name === 'compare_files')?.parameters.required).toEqual(['fileA', 'fileB']);
    expectError(await call('list_files', { maxFiles: 201 }), 'INVALID_TOOL_ARGUMENTS');
    expectError(await call('compare_files', { fileA: 'trace.json' }), 'INVALID_TOOL_ARGUMENTS');
    expectError(await call('list_files', {}, { targetPath: '/other' }), 'WORKSPACE_BINDING_MISMATCH');
    expect(workspace.listFiles).not.toHaveBeenCalled();
    const listing = await call('list_files', { maxFiles: 1, maxDepth: 0 });
    expect(listing.data).toEqual({
      files: [{ path: 'trace.json', byteSize: 2, modifiedAt: iso, extension: '.json' }], total: 1, truncated: false,
    });
    expect(workspace.listFiles).toHaveBeenCalledWith(['/fixture'], { maxFiles: 1, maxDepth: 0 });
  });

  it('parses four formats and distinguishes tool failure, stopping and task outcome', async () => {
    const bench = {
      metadata: { dataset: 'trajerrbench', reward: 0, task_description: 'Trace a local packet' },
      messages: [
        { step: 0, role: 'assistant', content: '[tool_calls]\n- lookup(value=1)' },
        { step: 1, role: 'assistant', content: '[tool_calls]\n- lookup(value=1)' },
        { step: 2, role: 'tool', name: 'lookup', content: 'ERROR: lookup did not complete', duration_ms: 3200 },
        { step: 3, role: 'assistant', content: 'Final response\n###STOP###' },
      ],
    };
    const generic = { messages: [{ role: 'assistant', toolCalls: [{ id: 'tc_one', name: 'probe' }] }] };
    const logs = jsonl([
      { type: 'tool_call', step: 0, toolName: 'probe', isError: true },
      { taskOutcome: 'passed', stopReason: 'completed' },
    ]);
    const { call } = build({ 'bench.json': JSON.stringify(bench), 'generic.json': JSON.stringify(generic),
      'trace.jsonl': logs, 'trace.log': 'INFO starting\nERROR exception\nWARN durationMs: 2250\n' });
    const overview = async (file: string) => TraceOverviewSchema.parse((await call('inspect_trace', { file })).data);
    expect(await overview('bench.json')).toMatchObject({
      format: 'trajerrbench_json', threeState: { taskOutcome: 'failed', terminationReason: '###STOP###', toolErrorCount: 1 },
      anomalies: { firstError: { step: 2, line: 1 }, retryLoops: [{ toolName: 'lookup', startStep: 0, endStep: 1, repeatCount: 2 }],
        slowSpans: [{ step: 2, durationMs: 3200 }] },
    });
    expect(await overview('generic.json')).toMatchObject({
      format: 'generic_json', threeState: { hasToolError: false, taskOutcome: 'unknown' },
    });
    expect(await overview('trace.jsonl')).toMatchObject({
      format: 'jsonl', threeState: { taskOutcome: 'passed', terminationReason: 'completed', hasToolError: true },
    });
    expect(await overview('trace.log')).toMatchObject({
      format: 'plain_text', anomalies: { firstError: { line: 2 }, slowSpans: [{ durationMs: 2250 }] },
    });
  });

  it('T3-07/T3-08 follows nested trajectories, preserves raw coordinates and compacts only step records', async () => {
    const action = { id: 'first', function: { name: 'lookup', arguments: { usage: 'semantic input' } } };
    const update = { id: 'second', name: 'update', arguments: { cost: 50 } };
    const payload = { error: false, cost: 50, status: 'applied', proof: { ground_truth: 'private-result' } };
    const messages = Array.from({ length: 24 }, (_, turn_idx) => ({
      turn_idx,
      ...(turn_idx === 2 ? { role: 'assistant', content: '', tool_calls: [action, update] }
        : turn_idx === 3 ? { role: 'tool', id: 'first', error: true, content: 'Unavailable' }
          : turn_idx === 4 ? { role: 'tool', id: 'second', content: payload, isError: false }
            : { role: 'user', content: 'Evidence 🙂 ' + turn_idx }),
      raw_data: { duplicate: 'r'.repeat(500), diagnostic: { extra: { annotation: 'private-raw' } } },
      usage: { tokens: 500 }, token_usage: 1, prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 1,
    }));
    const document = {
      tasks: [{ description: { purpose: 'Verify an update against its limits' } }],
      simulations: [
        { reward_info: { reward: 0 }, termination_reason: 'user_stop', messages,
          secret: { critical_error_step: 3, nested: { critical_error_type: 'private-marker' } } },
        { messages: [{ turn_idx: 100, content: 'Second run' }] },
      ],
    };
    const file = 'nested.json';
    const raw = JSON.stringify(document, null, 2).replaceAll('\n', '\r\n');
    const lines = raw.split('\r\n');
    const lineOf = (turn: number) => lines.findIndex((line) => line.trim() === '"turn_idx": ' + turn + ',');
    const errorLine = lines.findIndex((line) => line.trim() === '"error": true,') + 1;
    const { call } = build({ [file]: raw });
    const inspected = await call('inspect_trace', { file });
    expect(inspected.isError).toBe(false);
    expect(inspected.data).toMatchObject({
      stepCount: 24, taskSummary: 'Verify an update against its limits',
      threeState: { taskOutcome: 'failed', terminationReason: 'user_stop', toolErrorCount: 1 },
      anomalies: { firstError: { step: 3, line: errorLine } },
      toolCalls: [{ step: 2, toolName: 'lookup', isError: true }, { step: 2, toolName: 'update', isError: false }],
    });
    const classify = createTraceLineClassifier(raw);
    expect(classify(lines[errorLine - 1]!, errorLine)).toBe('error');
    expect(classify(lines[lineOf(3) - 1]!, lineOf(3))).toBe('other');

    const compact = await call('read_file_slice', { file, startStep: 0, endStep: 23 });
    expect(compact.isError).toBe(false);
    expect(Buffer.byteLength(compact.content)).toBeLessThanOrEqual(charLimit);
    expect(compact.data).toMatchObject({ hasMore: false, nextStep: null });
    expect(compact.data.steps.map(({ step, line }: { step: number; line: number }) => [step, line]))
      .toEqual(messages.map(({ turn_idx }) => [turn_idx, lineOf(turn_idx)]));
    expect(compact.data.steps[2].value).toEqual({ turn_idx: 2, role: 'assistant', content: '', tool_calls: [action, update] });
    expect(compact.data.steps[3].value).toEqual({ turn_idx: 3, role: 'tool', id: 'first', error: true, content: 'Unavailable' });
    expect(compact.data.steps[4].value).toEqual({
      turn_idx: 4, role: 'tool', id: 'second', content: { error: false, cost: 50, status: 'applied', proof: {} }, isError: false,
    });
    const telemetry = lines.findIndex((line) => line.includes('"raw_data"')) + 1;
    const original = await call('read_file_slice', { file, startLine: telemetry, limit: 2 });
    expect(original.data.lines.map(({ text }: { text: string }) => text)).toEqual(lines.slice(telemetry - 1, telemetry + 1));
    expect(original.content).toContain('raw_data');
    const sanitized = sanitizeTraceContent(raw, file);
    if (!sanitized.ok) throw new Error('Expected sanitized trace.');
    expect(sanitized.sanitized.split('\r\n')).toHaveLength(lines.length);
    for (const output of [sanitized.sanitized, inspected.content, compact.content, original.content]) {
      expect(output).not.toMatch(/annotation|ground_truth|critical_error|private-/);
    }
  });

  it.each([
    ['top-level turns', { turns: [{ stepNumber: 10 }, { step_number: 11 }] }, [10, 11]],
    ['top-level precedence', { history: [{ index: 7 }], runs: [{ messages: [{ step: 9 }] }] }, [7]],
    ['nested trajectory', { runs: [{ trajectory: [{ turn: 4 }, { index: 5 }, {}] }] }, [2, 4, 5]],
    ['nested events', { episodes: [{ events: [{ event: { step: 8 } }] }] }, [8]],
  ] as const)('selects %s using the supported keys and step aliases', async (_, document, expected) => {
    const file = 'trace.json';
    const { call } = build({ [file]: JSON.stringify(document, null, 2) });
    const data = (await call('read_file_slice', { file, startStep: 0 })).data;
    expect(data.steps.map(({ step }: { step: number }) => step)).toEqual(expected);
  });

  it('prefers explicit trace metadata to a nested run fallback', () => {
    const doc = JSON.stringify({
      terminationReason: 'external_stop', taskOutcome: 'passed', taskSummary: 'Top-level summary',
      tasks: [{ instruction: 'Nested instructions' }],
      trials: [{ terminationReason: 'user_stop', reward_info: { reward: 0 }, history: [{ status: 'failed' }] }],
    });
    expect(analyzeTraceContent('trace.json', doc)).toMatchObject({
      stepCount: 1, taskSummary: 'Top-level summary',
      threeState: { terminationReason: 'external_stop', taskOutcome: 'passed', hasToolError: false },
    });
  });

  it('M5.3-03 R1 resolves scores consistently across trace layouts and prefers explicit outcomes', async () => {
    const messages = [{ role: 'user', content: 'Check stock' }];
    const cases = [
      [{ reward_info: { reward: 0 } }, 'failed'],
      [{ reward_info: { reward: 1 } }, 'passed'],
      [{ reward: 0 }, 'failed'],
      [{ reward: 1 }, 'passed'],
      [{ reward_info: { reward: 0.5 } }, 'unknown'],
      [{ taskOutcome: 'passed', reward_info: { reward: 0 } }, 'passed'],
    ] as const;
    const samples = cases.flatMap(([outcome, expected], index) => {
      const run = { termination_reason: 'user_stop', messages, ...outcome };
      return [run, { runs: [run] }].map((value, layout) => ({
        file: 'score-' + index + '-' + (layout === 0 ? 'root' : 'nested') + '.json',
        raw: JSON.stringify(value), expected,
      }));
    });
    const { call } = build(Object.fromEntries(samples.map(({ file, raw }) => [file, raw])));
    for (const { file, expected } of samples) {
      const result = await call('inspect_trace', { file });
      expect(result.isError, file).toBe(false);
      expect(result.data, file).toMatchObject({
        stepCount: 1, threeState: { terminationReason: 'user_stop', taskOutcome: expected },
      });
    }
  });

  it.each(['object', 'string'] as const)('M5.3-03 R2 agrees with the error index for tool results encoded as %s', async (representation) => {
    const payload = { error: 'Stock unavailable', status: 'failed' };
    const samples = [undefined, false].map((isError) => ({
      file: isError === false ? 'explicit-success.json' : 'failure.json',
      expectedFailure: isError !== false,
      raw: JSON.stringify({ runs: [{ messages: [
        { turn_idx: 0, role: 'assistant', tool_calls: [{ id: 'stock', name: 'get_stock', arguments: {} }] },
        { turn_idx: 1, role: 'tool', tool_call_id: 'stock', name: 'get_stock',
          content: representation === 'object' ? payload : JSON.stringify(payload), isError },
      ] }] }, null, 2).replaceAll('\n', '\r\n'),
    }));
    const { call } = build(Object.fromEntries(samples.map(({ file, raw }) => [file, raw])));
    for (const { file, raw, expectedFailure } of samples) {
      const result = await call('inspect_trace', { file });
      expect(result.isError, file).toBe(false);
      expect(result.data).toMatchObject({
        threeState: { hasToolError: expectedFailure, toolErrorCount: expectedFailure ? 1 : 0 },
        toolCalls: [{ step: 0, toolName: 'get_stock', isError: expectedFailure }],
      });
      const lines = raw.split('\r\n');
      const classify = createTraceLineClassifier(raw);
      const marked = lines.flatMap((line, index) => classify(line, index + 1) === 'error' ? [index + 1] : []);
      const firstError = result.data.anomalies.firstError;
      if (expectedFailure) {
        const marker = representation === 'object' ? '"error": "Stock unavailable"' : '"content": "{';
        const line = lines.findIndex((text) => text.includes(marker)) + 1;
        expect(line).toBeGreaterThan(0);
        expect(firstError).toEqual({ step: 1, line, snippet: lines[line - 1]?.trim() });
        expect(marked).toEqual([line]);
      } else {
        expect(firstError).toBeNull();
        expect(marked).toEqual([]);
      }
    }
  });

  it('uses explicit tool success and retains structured and legacy text failures', async () => {
    const fixtures = [
      ['success.json', '{"ok":true,"error":null}', false, 0],
      ['legacy-success.json', '{"ok":true,"error":null}', undefined, 0],
      ['failure.json', 'The operation could not complete.', true, 1],
      ['legacy-failure.json', 'ERROR unavailable', undefined, 1],
      ['structured-failure.json', '{"error":"unavailable"}', undefined, 1],
      ['failed-status.json', '{"status":"error","message":"ERROR: lookup failed"}', undefined, 1],
      ['status-only-failure.json', '{"status":"error"}', undefined, 1],
      ['status-success.json', '{"status":"ok","message":"Checked prior ERROR records","error":null}', undefined, 0],
      ['explicit-success.json', '{"status":"error","message":"ERROR: lookup failed"}', false, 0],
    ] as const;
    const { call } = build(Object.fromEntries(fixtures.map(([file, content, isError]) => [file, JSON.stringify({
      metadata: { dataset: 'trajerrbench', reward: 1 },
      messages: [
        { role: 'assistant', step: 0, content: '[tool_calls]\n- lookup()' },
        { role: 'tool', step: 1, name: 'lookup', content, isError },
        { role: 'assistant', step: 2, content: '###STOP###' },
      ],
    }, null, 2)])));
    for (const [file, , , count] of fixtures) {
      const overview = TraceOverviewSchema.parse((await call('inspect_trace', { file })).data);
      expect(overview.threeState, file).toEqual({
        hasToolError: count > 0, toolErrorCount: count, taskOutcome: 'passed', terminationReason: '###STOP###',
      });
      if (count === 0) expect(overview.anomalies.firstError, file).toBeNull();
      else expect(overview.anomalies.firstError, file).toMatchObject({ step: 1 });
      if (file === 'failed-status.json') {
        expect(overview.anomalies.firstError).toMatchObject({ line: 16, snippet: expect.stringContaining('lookup failed') });
      }
    }
  });

  it('reports the final stop after an intermediate tool call and preserves an explicit run reason', async () => {
    const messages = [
      { id: 'msg_start', role: 'assistant', content: '', createdAt: iso, stopReason: 'tool_calls',
        toolCalls: [{ id: 'tc_lookup', name: 'lookup', arguments: {} }] },
      { id: 'msg_result', role: 'toolResult', content: 'done', createdAt: iso, toolCallId: 'tc_lookup',
        toolName: 'lookup', isError: false, durationMs: 1 },
      { id: 'msg_final', role: 'assistant', content: 'All done', createdAt: iso, stopReason: 'stop', toolCalls: [] },
    ].map((message) => AgentMessageSchema.parse(message));
    const { call } = build({
      'final.json': JSON.stringify({ messages }),
      'explicit.json': JSON.stringify({ stopReason: 'server_restarted', messages }),
      'terminal-event.json': JSON.stringify({ steps: [
        ...messages, { event: { type: 'agent_end', stopReason: 'max_steps' } },
      ] }),
      'in-progress.json': JSON.stringify({ messages: messages.slice(0, 2) }),
    });
    for (const [file, reason] of [
      ['final.json', 'stop'], ['explicit.json', 'server_restarted'],
      ['terminal-event.json', 'max_steps'], ['in-progress.json', null],
    ] as const) {
      expect(TraceOverviewSchema.parse((await call('inspect_trace', { file })).data).threeState.terminationReason)
        .toBe(reason);
    }
  });

  it('points to the effective decoded error field in a nested event', () => {
    const original = [
      '{',
      '  "steps": [{',
      '    "step": 7,',
      '    "level": "warn",',
      '    "metadata": {"level": "error"},',
      '    "event": {',
      '      "level": "error",',
      '      "l\\u0065vel":',
      '        "error"',
      '    }',
      '  }]',
      '}',
    ].join('\r\n');
    const overview = analyzeTraceContent('event.json', original);
    expect(overview.anomalies.firstError).toEqual({ step: 7, line: 9, snippet: '"error"' });
  });

  it('uses the effective failed call in a nested event array as first-error evidence', () => {
    const original = [
      '{', '  "steps": [{', '    "step": 7,', '    "event": {',
      '      "tool_calls": [{ "name": "overwritten", "isError": true }],',
      '      "tool_calls": [',
      '        { "isError": true },',
      '        { "name": "lookup", "isError": false, "is\\u0045rror":',
      '            true',
      '        }', '      ]', '    }', '  }]', '}',
    ].join('\r\n');
    const overview = analyzeTraceContent('event.json', original);
    expect(overview.threeState).toMatchObject({ hasToolError: true, toolErrorCount: 1 });
    expect(overview.anomalies.firstError).toEqual({ step: 7, line: 9, snippet: 'true' });
  });

  it('removes escaped and overwritten keys before every reading tool while retaining original positions', async () => {
    const original = [
      '{', '  "metadata":{"annotation":"answer-normal"},',
      '  "repeated":{"\\u0061nnotation":"answer-overwritten"},',
      '  "repeated":{"safe":true},',
      '  "steps":[', '    { "step": 7, "\\u0061nnotation":', '      {"nested":"answer-escaped"},',
      '      "toolName": "probe", "isError": true, "message": "ERROR at original line" }', '  ]', '}',
    ].join('\r\n') + '\r\n';
    const rows = '{"annotation":"answer-jsonl","step":2}\r\n\r\n'
      + '{"step":8,"toolName":"probe","isError":true,"message":"ERROR at original line"}\r\n';
    const { call } = build({ 'trace.json': original, 'trace.jsonl': rows, 'renamed.log': original });
    for (const [file, originalLine, step] of [['trace.json', 8, 7], ['trace.jsonl', 3, 8], ['renamed.log', 8, 7]] as const) {
      const results = await Promise.all([
        call('inspect_trace', { file }), call('read_file_slice', { file, startLine: originalLine, limit: 1 }),
        call('search_logs', { file, query: 'original line', contextLines: 1 }),
        call('compare_files', { fileA: file, fileB: file }),
        call('read_file_slice', { file, startStep: step, endStep: step }),
      ]);
      for (const result of results) {
        expect(result.isError, result.content).toBe(false);
        expect(result.content).not.toMatch(/answer-|annotation|critical_error|ground_truth/);
      }
      expect(results[0]?.data.anomalies.firstError.line).toBe(originalLine);
      expect(results[1]?.data.lines[0]).toMatchObject({ lineNumber: originalLine });
      expect(results[2]?.data.matches[0]).toMatchObject({ lineNumber: originalLine });
      expect(results[4]?.data.steps).toEqual([expect.objectContaining({ step })]);
    }
    const cleaned = sanitizeTraceContent(original, 'trace.json');
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) throw Error(cleaned.message);
    expect(cleaned.sanitized.length).toBe(original.length);
    expect([...cleaned.sanitized.matchAll(/\r\n/g)].map(({ index }) => index))
      .toEqual([...original.matchAll(/\r\n/g)].map(({ index }) => index));
    expect(JSON.parse(cleaned.sanitized).repeated).toEqual({ safe: true });
    expect(sanitizeTraceContent('{\n  "x": 1\n}\n', 'clean.json')).toMatchObject({
      sanitized: '{\n  "x": 1\n}\n', stripped: false,
    });
    expect(sanitizeTraceContent('[0, {"annotation": "answer-in-array"}]', 'renamed.log')).toMatchObject({
      ok: true, stripped: true, parsedJson: [0, {}],
    });
  });

  it.each([
    ['broken.json', '{\n "annotation":\n "private answer"\n'],
    ['broken.jsonl', '{"annotation":"private answer"}\n{"incomplete":\n'],
    ['broken.log', 'INFO local fixture\n{"annotation":"private answer"\n'],
  ])('fails closed without exposing damaged structured content in %s', async (file, content) => {
    const { call } = build({ [file]: content, 'clean.log': 'INFO good\n' });
    for (const response of await Promise.all([
      call('inspect_trace', { file }), call('read_file_slice', { file }), call('search_logs', { file, query: 'answer' }),
      call('compare_files', { fileA: 'clean.log', fileB: file }),
    ])) {
      expectError(response, 'UNSANITIZABLE_TRACE_JSON');
      expect(response.content).not.toContain('private answer');
    }
    expect((await call('search_logs', { query: 'good' })).data).toMatchObject({
      warnings: [{ file, code: 'UNSANITIZABLE_TRACE_JSON' }], totalMatches: 1, filesSearched: 1,
    });
  });

  it('slices original line and step positions and returns a byte-bounded continuation', async () => {
    const rows = jsonl([{ step: 7, content: '🚀'.repeat(5100) }, { step: 8, content: 'INFO ok' }]);
    const { call } = build({ 'trace.jsonl': rows });
    const first = await call('read_file_slice', { file: 'trace.jsonl', limit: 2 });
    expect(first.isError).toBe(false);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(charLimit);
    expect(first.data).toMatchObject({ lines: [{ lineNumber: 1 }], lineTruncated: true, hasMore: true, nextOffsetLine: 2 });
    const second = await call('read_file_slice', { file: 'trace.jsonl', startLine: 2, level: 'info', q: 'ok' });
    expect(TextSliceResponseSchema.parse(second.data).lines.map(({ lineNumber }) => lineNumber)).toEqual([2]);
    const steps = await call('read_file_slice', { file: 'trace.jsonl', startStep: 7, endStep: 8 });
    expect(Buffer.byteLength(steps.content)).toBeLessThanOrEqual(charLimit);
    expect(steps.data).toMatchObject({ steps: [{ step: 7, line: 1 }], hasMore: true, nextStep: 8, stepTruncated: true });
  });

  it('searches by keyword, regex, severity and context, and rejects unsupported regexes', async () => {
    const { call } = build({ 'trace.log': 'INFO context\nERROR local timeout\nWARN after\nERROR again\n' });
    const accepted = await call('search_logs', { regex: '^ERROR.*timeout$', level: 'error', contextLines: 1 });
    expect(accepted.data).toMatchObject({
      matches: [{ file: 'trace.log', lineNumber: 2, text: 'ERROR local timeout',
        contextBefore: [{ lineNumber: 1 }], contextAfter: [{ lineNumber: 3 }] }], totalMatches: 1,
    });
    expect((await call('search_logs', { query: 'error', maxMatches: 1 })).data).toMatchObject({
      totalMatches: 2, truncated: true, matches: [{ lineNumber: 2 }],
    });
    for (const regex of ['[', '(a)\\1', 'x(?=y)', '(a+)+', 'x'.repeat(201)]) {
      expectError(await call('search_logs', { regex }), 'INVALID_REGEX');
    }
  });

  it('cooperatively stops in the middle of one large file and of a long physical line', async () => {
    for (const text of ['INFO diagnostic event without requested term\n'.repeat(452_000), 'x'.repeat(19 * 1024 * 1024)]) {
      const controller = new AbortController();
      let yielded = 0;
      let turn: Promise<void> | undefined;
      const { call } = build({ 'this.log': text }, {
        onRead: () => {
          turn = nextTurn().then(() => { yielded++; return nextTurn(); }).then(() => { yielded++; controller.abort(); });
        },
      });
      const result = await call('search_logs', { file: 'this.log', regex: 'ERROR.*needle' }, { signal: controller.signal });
      await turn;
      expect(yielded).toBe(2);
      expectError(result, 'TOOL_ABORTED');
    }
  });

  it('checks artifact ownership before reading, handles missing IDs and caps UTF-8 bytes and lines', async () => {
    let meta = artifactMeta('ses_other');
    const getMeta = vi.fn(() => meta);
    const readSlice = vi.fn(() => page([{ lineNumber: 1, level: 'info', text: 'hello' }]));
    const { call } = build({}, { store: { getMeta, readSlice, save: () => meta } });
    expectError(await call('read_artifact_slice', { artifactId: 'invalid' }), 'INVALID_TOOL_ARGUMENTS');
    expect(getMeta).not.toHaveBeenCalled();
    expectError(await call('read_artifact_slice', { artifactId: 'art_one' }), 'ARTIFACT_FORBIDDEN');
    expect(readSlice).not.toHaveBeenCalled();
    meta = artifactMeta('ses_one');
    const ordinary = await call('read_artifact_slice', { artifactId: 'art_one', startLine: 1, limit: 1, query: 'hello' });
    expect(ordinary.isError).toBe(false);
    expect(ordinary.data.lines).toEqual([{ lineNumber: 1, level: 'info', text: 'hello' }]);
    expect(readSlice).toHaveBeenLastCalledWith('art_one', { offsetLine: 1, limit: 1, level: undefined, query: 'hello' });
    readSlice.mockReturnValueOnce(page(Array.from({ length: 3 }, (_, index) => ({
      lineNumber: 5 + index, level: 'info', text: '文'.repeat(1000),
    }))));
    const pageResult = await call('read_artifact_slice', { artifactId: 'art_one', startLine: 5 });
    expect(Buffer.byteLength(pageResult.content)).toBeLessThanOrEqual(charLimit);
    expect(pageResult.data).toMatchObject({ hasMore: true, nextOffsetLine: 6, lines: [{ lineNumber: 5 }] });
    readSlice.mockReturnValueOnce(page([
      { lineNumber: 1, level: 'info', text: '🚀中文'.repeat(2300) }, { lineNumber: 2, level: 'info', text: 'after' },
    ]));
    const long = await call('read_artifact_slice', { artifactId: 'art_one' });
    expect(Buffer.byteLength(long.content)).toBeLessThanOrEqual(charLimit);
    expect(long.data).toMatchObject({ lineTruncated: true, hasMore: true, nextOffsetLine: 2 });
    expect(long.data.lines[0].text).not.toMatch(/[\uD800-\uDFFF]/u);
    readSlice.mockReturnValueOnce(page([{ lineNumber: 1, level: 'info', text: 'broken\uD800text' }]));
    expect((await call('read_artifact_slice', { artifactId: 'art_one' })).data.lines[0].text).toBe('broken\uFFFDtext');

    const missing = build();
    expectError(await missing.call('read_artifact_slice', { artifactId: 'art_missing' }), 'ARTIFACT_NOT_FOUND');
    readSlice.mockReturnValueOnce(page(Array.from({ length: 250 }, (_, index) => ({
      lineNumber: index + 1, level: 'info', text: '',
    }))));
    const max = await call('read_artifact_slice', { artifactId: 'art_one' });
    expect(max.data.lines.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(max.content)).toBeLessThanOrEqual(charLimit);
  });

  it('detects the exact call-sequence divergence when summary metrics match', async () => {
    const a = jsonl([{ step: 3, toolName: 'first' }, { step: 9, toolName: 'other' }]);
    const b = jsonl([{ step: 3, toolName: 'other' }, { step: 9, toolName: 'first' }]);
    expect(analyzeTraceContent('same.jsonl', a)).toEqual(analyzeTraceContent('same.jsonl', b));
    const { call } = build({ 'a.jsonl': a, 'b.jsonl': b });
    expect((await call('compare_files', { fileA: 'a.jsonl', fileB: 'b.jsonl' })).data).toMatchObject({
      firstDivergenceStep: 3, toolSequenceDiff: { callA: { step: 3, toolName: 'first' },
        callB: { step: 3, toolName: 'other' } },
    });
  });

  it('cancels the mock heartbeat and timers and bypasses fixtures in live mode', async () => {
    const { call, workspace } = build({ 'diagnostics.fixture.json': JSON.stringify({
      defaultScenario: 'slow', slow: { delayMs: 4000, progressIntervalMs: 500 },
      error: { errorCode: 'MOCK_UPSTREAM_TIMEOUT' },
    }) });
    expect((await call('check_runtime_diagnostics', {}, { toolMode: 'live' })).data).toMatchObject({
      mode: 'live', status: 'healthy', fileCount: 1,
    });
    expect(workspace.readFile).not.toHaveBeenCalled();
    expectError(await call('check_runtime_diagnostics', { scenario: 'error' }), 'MOCK_UPSTREAM_TIMEOUT');

    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const onProgress = vi.fn(() => { controller.abort(); });
      const running = call('check_runtime_diagnostics', {}, { signal: controller.signal, onProgress });
      await vi.advanceTimersByTimeAsync(500);
      expectError(await running, 'TOOL_ABORTED');
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps UTF-8 truncation inside the byte budget without isolated surrogate code units', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom('a', '文', '😊', '🚀', '𠮷', '\uD800', '\uDFFF'), { maxLength: 300 }),
      fc.integer({ min: 0, max: 6144 }),
      (points, limit) => {
        const result = truncateUtf8Safe(points.join(''), limit);
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(limit);
        expect(result.text).not.toMatch(/[\uD800-\uDFFF]/u);
      },
    ), { numRuns: 128, seed: 20261125 });
  });
});
