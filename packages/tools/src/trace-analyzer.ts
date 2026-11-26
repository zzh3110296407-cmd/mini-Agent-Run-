import { TraceOverviewSchema, type LogLevel, type TraceOverview } from '@mini-agent-run/shared';
import {
  asObject, locateTraceStructure, sanitizeTraceContent, traceValueOffset, traceLines, type JsonPath, type RecordLocation,
} from './sanitize.js';
import { ToolError } from './tool-error.js';

type TraceObject = Record<string, unknown>;
type Sanitized = Extract<ReturnType<typeof sanitizeTraceContent>, { ok: true }>;
type Outcome = TraceOverview['threeState']['taskOutcome'];
type Call = { step: number; toolName: string; isError: boolean };
type TraceRecord = { step: number; line: number; value: unknown };

export interface TraceAnalysisDetails {
  overview: TraceOverview;
  toolCalls: Call[];
}

export { asObject } from './sanitize.js';

function text(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function nonnegative(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function firstText(row: TraceObject | undefined, keys: readonly string[]) {
  return keys.map((key) => text(row?.[key])).find((value) => value !== undefined);
}

function rowData(value: unknown) {
  const row = asObject(value);
  const event = asObject(row?.event);
  return event ? { ...row, ...event } : row;
}

function sourceRecords(trace: Sanitized): { values: unknown[]; locations: RecordLocation[] } {
  const root = asObject(trace.parsedJson);
  const location = trace.locations;
  if (trace.parsedLines) return { values: trace.parsedLines, locations: location?.records ?? [] };
  const { trajectory } = locateTraceStructure(root);
  if (trajectory) return { values: trajectory.values, locations: location?.trajectory ?? [] };
  if (Array.isArray(trace.parsedJson)) return { values: trace.parsedJson, locations: location?.records ?? [] };
  if (root) return { values: [root], locations: location?.document ? [location.document] : [] };
  return { values: [], locations: [] };
}

function indexedRecords(trace: Sanitized) {
  const { values, locations } = sourceRecords(trace);
  const lines = traceLines(trace.sanitized);
  let current = lines.next().value;
  return values.map((value, index) => {
    const row = rowData(value);
    const span = locations[index];
    while (current && span && current.end < span.start) current = lines.next().value;
    const step = nonnegative(row?.step) ?? nonnegative(row?.stepNumber) ?? nonnegative(row?.step_number)
      ?? nonnegative(row?.turn_idx) ?? nonnegative(row?.turn) ?? nonnegative(row?.index) ?? index;
    const record: TraceRecord = { value, step, line: span?.line ?? current?.line ?? 1 };
    return { row, span, record };
  });
}

export function traceRecords(trace: Sanitized): TraceRecord[] {
  return indexedRecords(trace).map(({ record }) => record);
}

export function loadTrace(content: string, relativePath: string): Sanitized {
  const trace = sanitizeTraceContent(content, relativePath);
  if (!trace.ok) throw new ToolError(trace.code, trace.message);
  return trace;
}

const strongError = /\b(?:ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/i;
const structuredError = /"(?:level|status)"\s*:\s*"(?:error|fatal|failed)"|"(?:isError|is_error)"\s*:\s*true\b/i;
const durationPattern = /(?:^|[^\w])(?:duration_ms|durationMs|elapsed_ms|elapsedMs|latency_ms|latencyMs)["']?\s*[:=]\s*(\d+)/i;

export function classifyTraceLine(line: string): LogLevel {
  if (strongError.test(line) || structuredError.test(line)) return 'error';
  if (/\b(?:WARN|WARNING)\b/i.test(line)) return 'warn';
  if (/\b(?:INFO|DEBUG|TRACE)\b/i.test(line)) return 'info';
  return 'other';
}

function asOutcome(value: unknown): Outcome | undefined {
  if (value === true) return 'passed';
  if (value === false) return 'failed';
  switch (text(value)?.toLowerCase()) {
    case 'passed': case 'pass': case 'success': case 'succeeded': return 'passed';
    case 'failed': case 'fail': case 'failure': case 'error': return 'failed';
    case 'unknown': return 'unknown';
    default: return undefined;
  }
}

function findOutcome(row: TraceObject | undefined, allowStatus: boolean) {
  const keys = ['taskOutcome', 'task_outcome', 'outcome', 'passed', 'success', ...(allowStatus ? ['status'] : [])];
  return keys.map((key) => asOutcome(row?.[key])).find((value) => value !== undefined);
}

function rewardOutcome(value: unknown): Outcome | undefined {
  return value === 1 ? 'passed' : value === 0 ? 'failed' : undefined;
}

function scoredOutcome(run: TraceObject | undefined) {
  return rewardOutcome(asObject(run?.reward_info)?.reward) ?? rewardOutcome(run?.reward);
}

function reason(row: TraceObject | undefined) {
  return firstText(row, ['termination_reason', 'terminationReason', 'stop_reason', 'stopReason']);
}

function namesFromText(body: string) {
  const heading = /(?:^|\r?\n)\[tool_calls\][\t ]*(?:\r?\n|$)/i.exec(body);
  if (!heading) return [];
  const block = body.slice(heading.index + heading[0].length).split(/(?:^|\r?\n)\[[a-z_]+\][\t ]*(?:\r?\n|$)/i, 1)[0] ?? '';
  return [...block.matchAll(/^[\t ]*-[\t ]*([\w.-]+)[\t ]*\(/gm)].map((match) => match[1] ?? '');
}

function callName(call: TraceObject | undefined) {
  return firstText(asObject(call?.function), ['name']) ?? firstText(call, ['toolName', 'tool', 'name']);
}

function isToolMessage(row: TraceObject) {
  return row.role === 'tool' || row.role === 'toolResult';
}

function recordedError(row: TraceObject) {
  if (typeof row.isError === 'boolean') return { field: 'isError', failed: row.isError };
  if (typeof row.is_error === 'boolean') return { field: 'is_error', failed: row.is_error };
  if (text(row.level)?.toLowerCase() === 'error') return { field: 'level', failed: true };
  const error = row.error;
  if (error !== undefined && error !== null && error !== false && error !== '') return { field: 'error', failed: true };
}

function structuredResult(row: TraceObject) {
  const marker = recordedError(row);
  if (marker) return marker;
  const status = text(row.status)?.trim() ?? '';
  if (/^(?:error|fatal|failed|failure)$/i.test(status)) return { field: 'status', failed: true };
  if (row.success === false) return { field: 'success', failed: true };
  if (row.ok === false) return { field: 'ok', failed: true };
  if (row.success === true) return { field: 'success', failed: false };
  if (row.ok === true) return { field: 'ok', failed: false };
  if (/^(?:ok|success|succeeded|passed)$/i.test(status)) return { field: 'status', failed: false };
}

function structuredFailureField(row: TraceObject) {
  const result = structuredResult(row);
  return result?.failed ? result.field : undefined;
}

const toolFailurePrefix = /^\s*\[?(?:ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/i;
const nonzeroCommandExit = /(?:^|\r?\n)[ \t]*\[Command finished with exit code -?[1-9]\d*\]$/i;

function errorEvidencePath(row: TraceObject): JsonPath | undefined {
  const toolMessage = isToolMessage(row);
  const declared = toolMessage ? structuredResult(row) : recordedError(row);
  if (declared) return declared.failed ? [declared.field] : undefined;
  if (!toolMessage) return;

  let payloadSucceeded = false;
  let textFailure: JsonPath | undefined;
  for (const bodyField of ['content', 'text', 'message']) {
    const value = row[bodyField];
    let payload = asObject(value);
    if (!payload) {
      const body = text(value);
      if (body === undefined) continue;
      const first = body.trimStart().charAt(0);
      if (first === '{' || first === '[') {
        try {
          payload = asObject(JSON.parse(body));
          if (!payload) continue;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      if (!payload) {
        if (toolFailurePrefix.test(body) || (nonzeroCommandExit.test(body.trimEnd()) && strongError.test(body))) {
          textFailure ??= [bodyField];
        }
        continue;
      }
    }
    const result = structuredResult(payload);
    if (!result) continue;
    if (result.failed) return typeof value === 'string' ? [bodyField] : [bodyField, result.field];
    payloadSucceeded = true;
  }
  // A successful result can quote earlier failures in an accompanying note.
  return payloadSucceeded ? undefined : textFailure;
}

function firstEvidence(
  source: string, span: RecordLocation | undefined, record: TraceRecord, body: string, paths: readonly JsonPath[],
) {
  if (span) {
    const block = source.slice(span.start, span.end);
    const event = asObject(asObject(record.value)?.event);
    const offsets = paths.map((path) => {
      const field = path[0];
      return traceValueOffset(block, event && typeof field === 'string' && Object.hasOwn(event, field)
        ? ['event', ...path] : path);
    }).filter((offset) => offset !== undefined);
    const firstOffset = Math.min(...offsets);
    for (const { line, start, end, text: snippet } of traceLines(block)) {
      if (firstOffset >= start && firstOffset < end) {
        return { step: record.step, line: record.line + line - 1, snippet: snippet.trim().slice(0, 240) };
      }
    }
  }
  return { step: record.step, line: record.line, snippet: (body || 'Tool error').trim().slice(0, 240) };
}

const levelPriority: Record<LogLevel, number> = { other: 0, info: 1, warn: 2, error: 3 };

function declaredLevel(value: unknown): LogLevel {
  const level = text(value)?.trim() ?? '';
  if (/^(?:error|fatal|critical|exception|traceback)$/i.test(level)) return 'error';
  if (/^(?:warn|warning)$/i.test(level)) return 'warn';
  if (/^(?:info|debug|trace)$/i.test(level)) return 'info';
  return 'other';
}

function* logLevelEvidence(row: TraceObject): IterableIterator<{ level: LogLevel; path: JsonPath }> {
  const path = errorEvidencePath(row);
  const declared = path === undefined ? structuredResult(row) : undefined;
  if (path !== undefined) {
    yield { level: 'error', path };
  } else if (declared?.failed) {
    yield { level: 'error', path: [declared.field] };
  } else {
    const levelField = text(row.level) ? 'level' : 'severity';
    const level = declaredLevel(row[levelField]);
    const result = isToolMessage(row) ? declared : recordedError(row);
    if (level !== 'other' && (level !== 'error' || !result)) yield { level, path: [levelField] };
  }

  const callsField = Array.isArray(row.toolCalls) ? 'toolCalls' : 'tool_calls';
  const calls = row[callsField];
  if (Array.isArray(calls)) {
    for (const [index, call] of calls.entries()) {
      const data = asObject(call);
      const marker = data && structuredFailureField(data);
      if (marker !== undefined) yield { level: 'error', path: [callsField, index, marker] };
    }
  }
}

function classifyStandaloneLogLine(line: string): LogLevel {
  if (/^\s*(?:\{|\[)/u.test(line)) {
    try {
      const parsed: unknown = JSON.parse(line);
      let level: LogLevel = 'other';
      for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
        const row = rowData(value);
        if (!row) continue;
        for (const evidence of logLevelEvidence(row)) {
          if (levelPriority[evidence.level] > levelPriority[level]) level = evidence.level;
        }
      }
      return level;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return classifyTraceLine(line);
}

export function createTraceLineClassifier(content: string): (text: string, lineNumber: number) => LogLevel {
  if (!/^\s*(?:\{|\[)/u.test(content)) return classifyStandaloneLogLine;
  const trace = sanitizeTraceContent(content, 'trace.json');
  if (!trace.ok) return classifyStandaloneLogLine;

  const levels = new Map<number, LogLevel>();
  for (const { row, span, record } of indexedRecords(trace)) {
    if (!row) continue;
    for (const { level, path } of logLevelEvidence(row)) {
      const { line = record.line } = firstEvidence(trace.sanitized, span, record, '', [path]);
      if (levelPriority[level] > levelPriority[levels.get(line) ?? 'other']) levels.set(line, level);
    }
  }
  return (_text, lineNumber) => levels.get(lineNumber) ?? 'other';
}

function retryLoops(calls: readonly Call[]): TraceOverview['anomalies']['retryLoops'] {
  const loops: TraceOverview['anomalies']['retryLoops'] = [];
  let start = 0;
  while (start < calls.length) {
    const first = calls[start];
    if (!first) break;
    let end = start + 1;
    while (calls[end]?.toolName === first.toolName) end++;
    const last = calls[end - 1] ?? first;
    if (end - start >= 2) {
      loops.push({ toolName: first.toolName, startStep: first.step, endStep: last.step, repeatCount: end - start });
    }
    start = end;
  }
  return loops;
}

export function analyzeTraceDetails(relativePath: string, content: string): TraceAnalysisDetails {
  const trace = loadTrace(content, relativePath);
  const root = asObject(trace.parsedJson);
  const metadata = asObject(root?.metadata);
  const format = trace.parsedLines ? 'jsonl'
    : trace.parsedJson === undefined ? 'plain_text'
      : metadata?.dataset === 'trajerrbench' || (Array.isArray(root?.messages) && root.messages.some((value) => {
        const row = asObject(value);
        return typeof row?.step === 'number' && typeof row.role === 'string'
          && typeof row.content === 'string' && /\[tool_calls\]|###STOP###/.test(row.content);
      })) ? 'trajerrbench_json' : 'generic_json';
  const toolCalls: Call[] = [];
  const callsById = new Map<string, Call>();
  const callsByName = new Map<string, Call>();
  const reported = new Set<Call>();
  const slowSpans: TraceOverview['anomalies']['slowSpans'] = [];
  let firstError: TraceOverview['anomalies']['firstError'] = null;
  let unmatchedErrors = 0;
  const { primaryRun } = locateTraceStructure(root);
  const primaryTask = Array.isArray(root?.tasks) ? asObject(root.tasks[0]) : undefined;
  const declaredRunReason = reason(root) ?? reason(metadata) ?? reason(primaryRun);
  let runEndReason: string | undefined;
  let observedReason: string | undefined;
  const declaredOutcome = [
    findOutcome(root, true), findOutcome(metadata, true), scoredOutcome(root), scoredOutcome(metadata),
    findOutcome(primaryRun, true), scoredOutcome(primaryRun),
  ].find((outcome) => outcome !== undefined && outcome !== 'unknown');
  let taskOutcome: Outcome | undefined = declaredOutcome;
  const records = indexedRecords(trace);

  for (const { row, span, record } of records) {
    if (!row) continue;
    const { step } = record;
    const body = firstText(row, ['content', 'text', 'message']) ?? '';
    const name = callName(row);
    const id = firstText(row, ['toolCallId', 'tool_call_id', 'callId'])
      ?? (isToolMessage(row) ? text(row.id) : undefined);
    const eventType = firstText(row, ['type', 'event_type', 'eventType']);
    const evidencePath = errorEvidencePath(row);
    const failed = evidencePath !== undefined;
    const explicitResult = /(?:result|execution_end|completed|failed)$/.test(eventType ?? '') || row.role === 'tool';
    const callsField = Array.isArray(row.toolCalls) ? 'toolCalls' : 'tool_calls';
    const listed = row[callsField];
    const namedCalls: { name: string; id?: string; failed: boolean }[] = [];
    let failedCallIndex: number | undefined;
    for (const [index, call] of (Array.isArray(listed) ? listed : []).entries()) {
      const data = asObject(call);
      const toolName = callName(data);
      if (!toolName) continue;
      const callFailed = data?.isError === true;
      if (callFailed) failedCallIndex ??= index;
      namedCalls.push({
        name: toolName, id: firstText(data, ['id', 'toolCallId', 'tool_call_id']), failed: callFailed,
      });
    }
    if (row.role === 'assistant' && namedCalls.length === 0) {
      for (const toolName of namesFromText(body)) namedCalls.push({ name: toolName, failed: false });
    }
    const candidate = (id ? callsById.get(id) : undefined) ?? (name ? callsByName.get(name) : toolCalls.at(-1));
    const matchingResult = candidate && (id || !reported.has(candidate)) ? candidate : undefined;
    if (namedCalls.length === 0 && name && row.role !== 'system' && row.role !== 'user'
      && (!explicitResult || (trace.parsedLines && !matchingResult))) {
      namedCalls.push({ name, id, failed });
    }

    for (const call of namedCalls) {
      const indexed = call.id ? callsById.get(call.id) : undefined;
      if (indexed) indexed.isError ||= call.failed;
      else {
        const entry: Call = { step, toolName: call.name, isError: call.failed };
        toolCalls.push(entry);
        callsByName.set(call.name, entry);
        if (call.id) callsById.set(call.id, entry);
        if (explicitResult) reported.add(entry);
      }
    }
    if (failed && namedCalls.length === 0) {
      const described = explicitResult ? matchingResult
        : (id ? callsById.get(id) : undefined) ?? (name ? callsByName.get(name) : undefined);
      if (described) described.isError = true;
      else unmatchedErrors++;
    }
    if (explicitResult && matchingResult) reported.add(matchingResult);
    if (firstError === null && (failed || failedCallIndex !== undefined)) {
      const paths: JsonPath[] = evidencePath === undefined ? [] : [evidencePath];
      if (failedCallIndex !== undefined) paths.push([callsField, failedCallIndex, 'isError']);
      firstError = firstEvidence(trace.sanitized, span, record, body, paths);
    }

    const terminalEvent = /^(?:run_end|agent_end|task_end|outcome|summary)$/.test(eventType ?? '');
    const rowReason = reason(row);
    const continuation = /^(?:tool_calls|function_call|tool_use)$/i.test(rowReason?.trim() ?? '');
    if (rowReason !== undefined && !continuation && (terminalEvent || !isToolMessage(row))) {
      if (terminalEvent) runEndReason = rowReason;
      else observedReason = rowReason;
    } else if (body.trimEnd().endsWith('###STOP###')) {
      observedReason = '###STOP###';
    } else if (name === 'transfer_to_human_agents' || namedCalls.some((call) => call.name === 'transfer_to_human_agents')) {
      observedReason ??= 'transfer_to_human_agents';
    }
    if (declaredOutcome === undefined) {
      const outcome = findOutcome(row, terminalEvent || (!name && !eventType));
      taskOutcome = outcome ?? taskOutcome;
    }
    const durationMs = nonnegative(row.duration_ms) ?? nonnegative(row.durationMs) ?? nonnegative(row.elapsed_ms)
      ?? nonnegative(row.elapsedMs) ?? nonnegative(row.latency_ms) ?? nonnegative(row.latencyMs);
    if (durationMs !== undefined && durationMs >= 1000) slowSpans.push({ step, toolName: name, durationMs });
  }

  let lineCount = 0;
  for (const { line, text: lineText } of traceLines(trace.sanitized)) {
    lineCount = line;
    if (format !== 'plain_text') continue;
    if (classifyTraceLine(lineText) === 'error') {
      unmatchedErrors++;
      firstError ??= { line, snippet: lineText.trim().slice(0, 240) };
    }
    if (lineText.trimEnd().endsWith('###STOP###')) observedReason = '###STOP###';
    const durationMs = Number(durationPattern.exec(lineText)?.[1]);
    if (Number.isSafeInteger(durationMs) && durationMs >= 1000) slowSpans.push({ durationMs });
  }

  const toolErrorCount = toolCalls.filter(({ isError }) => isError).length + unmatchedErrors;
  const overview = TraceOverviewSchema.parse({
    file: relativePath, format, byteSize: Buffer.byteLength(content), lineCount,
    stepCount: format === 'plain_text' ? null : records.length,
    taskSummary: firstText(metadata, ['task_description', 'taskSummary', 'task_summary'])
      ?? firstText(root, ['taskSummary', 'task_summary', 'task_description'])
      ?? text(asObject(primaryTask?.description)?.purpose)
      ?? firstText(primaryTask, ['task_description', 'instruction']) ?? null,
    threeState: {
      terminationReason: declaredRunReason ?? runEndReason ?? observedReason ?? null,
      hasToolError: toolErrorCount > 0, toolErrorCount, taskOutcome: taskOutcome ?? 'unknown',
    },
    anomalies: { firstError, retryLoops: retryLoops(toolCalls), slowSpans },
  });
  return { overview, toolCalls };
}

export function analyzeTraceContent(relativePath: string, content: string): TraceOverview {
  return analyzeTraceDetails(relativePath, content).overview;
}
