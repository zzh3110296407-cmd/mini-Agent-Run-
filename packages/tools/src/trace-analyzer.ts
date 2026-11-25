import { TraceOverviewSchema, type LogLevel, type TraceOverview } from '@mini-agent-run/shared';
import { sanitizeTraceContent, traceFieldValueOffset, traceLines, type RecordLocation } from './sanitize.js';
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

export function asObject(value: unknown): TraceObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as TraceObject : undefined;
}

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
  if (Array.isArray(root?.messages)) return { values: root.messages, locations: location?.messages ?? [] };
  if (Array.isArray(root?.steps)) return { values: root.steps, locations: location?.steps ?? [] };
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
    const step = nonnegative(row?.step) ?? nonnegative(row?.stepNumber) ?? nonnegative(row?.step_number) ?? index;
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

function errorEvidenceField(row: TraceObject, body: string, bodyField: string | undefined) {
  const structured = recordedError(row);
  if (structured) return structured.failed ? structured.field : undefined;
  if (!isToolMessage(row) || bodyField === undefined) return;
  const first = body.trimStart().charAt(0);
  if (first === '{' || first === '[') {
    try {
      const payload = asObject(JSON.parse(body));
      return payload && recordedError(payload)?.failed ? bodyField : undefined;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return strongError.test(body) ? bodyField : undefined;
}

function firstEvidence(
  source: string, span: RecordLocation | undefined, record: TraceRecord, body: string, field: string | undefined,
) {
  if (span) {
    const block = source.slice(span.start, span.end);
    const offset = field === undefined ? undefined : traceFieldValueOffset(block, field);
    for (const { line, start, end, text: snippet } of traceLines(block)) {
      const hasEvidence = offset === undefined
        ? structuredError.test(snippet) || /"error"\s*:\s*(?!null\b|false\b|""|$)\S/i.test(snippet)
          || (body && strongError.test(body) && strongError.test(snippet))
        : offset >= start && offset < end;
      if (hasEvidence) {
        return { step: record.step, line: record.line + line - 1, snippet: snippet.trim().slice(0, 240) };
      }
    }
  }
  return { step: record.step, line: record.line, snippet: (body || 'Tool error').trim().slice(0, 240) };
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
  const declaredRunReason = reason(root) ?? reason(metadata);
  let runEndReason: string | undefined;
  let observedReason: string | undefined;
  const reward = metadata?.reward;
  let taskOutcome: Outcome | undefined = reward === 1 ? 'passed' : reward === 0 ? 'failed'
    : findOutcome(metadata, true) ?? findOutcome(root, true);
  const records = indexedRecords(trace);

  for (const { row, span, record } of records) {
    if (!row) continue;
    const { step } = record;
    const bodyField = ['content', 'text', 'message'].find((key) => text(row[key]) !== undefined);
    const body = bodyField === undefined ? '' : text(row[bodyField]) ?? '';
    const name = callName(row);
    const id = firstText(row, ['toolCallId', 'tool_call_id', 'callId']);
    const eventType = firstText(row, ['type', 'event_type', 'eventType']);
    const evidenceField = errorEvidenceField(row, body, bodyField);
    const failed = evidenceField !== undefined;
    const explicitResult = /(?:result|execution_end|completed|failed)$/.test(eventType ?? '') || row.role === 'tool';
    const listed = Array.isArray(row.toolCalls) ? row.toolCalls : Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const namedCalls: { name: string; id?: string; failed: boolean }[] = [];
    for (const call of listed) {
      const data = asObject(call);
      const toolName = callName(data);
      if (toolName) namedCalls.push({
        name: toolName, id: firstText(data, ['id', 'toolCallId', 'tool_call_id']), failed: data?.isError === true,
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
    if (firstError === null && (failed || namedCalls.some((call) => call.failed))) {
      firstError = firstEvidence(trace.sanitized, span, record, body, evidenceField);
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
    if (reward !== 0 && reward !== 1) {
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
      ?? firstText(root, ['taskSummary', 'task_summary', 'task_description']) ?? null,
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
