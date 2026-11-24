import * as shared from '@mini-agent-run/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const timestamp = '2026-11-24T03:00:00.000Z';
const sessionId = 'ses_example';
const runId = 'run_example';
const messageId = 'msg_example';
const toolCallId = 'tc_example';
const artifactId = 'art_example';

const summary = {
  byteSize: 0, lineCount: 0, truncatedForLlm: false,
  levelCounts: { error: 0, warn: 0, info: 0, other: 0 },
  firstErrorLine: null, previewHead: '',
};
const request = { id: toolCallId, name: 'inspect_trace', arguments: { file: 'trace.json' } };
const assistant = { id: messageId, role: 'assistant', content: '', toolCalls: [request], createdAt: timestamp };
const pending = { toolCallId, toolName: request.name, startedAt: timestamp };
const problem = { code: 'invalid_input', message: 'Invalid target' };
const evidence = { kind: 'file_line', label: 'First failure', file: ' trace.json', startLine: 2, endLine: 2 };
const conclusion = { summary: 'One step failed', evidence: [evidence], recommendations: ['Check inputs'] };
const state = {
  runId, sessionId, status: 'pending', systemPrompt: '',
  model: { provider: 'example', modelId: 'example-model' },
  messages: [assistant], pendingToolCalls: [pending], step: 0, maxSteps: 12, stopReason: null, error: null,
};
const run = {
  id: runId, sessionId, retryOfRunId: null, prompt: 'Inspect the trace', status: 'pending',
  stopReason: null, errorCode: null, errorMessage: null, modelProvider: 'example', modelId: 'example-model',
  toolMode: 'mock', stepCount: 0, maxSteps: 12, finalAnswer: null, conclusion: null,
  lastSeq: 0, createdAt: timestamp, startedAt: null, endedAt: null, durationMs: null,
};
const session = {
  id: sessionId, title: 'Example', titleSource: 'auto', targetPath: ' trace.json',
  pathType: 'file', createdAt: timestamp, updatedAt: timestamp,
};
const threeState = { terminationReason: null, hasToolError: false, toolErrorCount: 0, taskOutcome: 'unknown' };
const anomalies = { firstError: null, retryLoops: [], slowSpans: [] };
const entry = { name: ' trace.json', path: ' trace.json', kind: 'file' };
const line = { lineNumber: 1, level: 'info', text: 'Example' };
const page = {
  totalLines: 2, matchedLines: 2, offsetLine: 1, limit: 1, hasMore: true, nextOffsetLine: 2, lines: [line],
};
const event = {
  seq: 1, runId, timestamp, event: { type: 'turn_start', step: 1 },
};
const idSchemas = [
  [shared.SessionIdSchema, 'ses_'], [shared.RunIdSchema, 'run_'], [shared.ArtifactIdSchema, 'art_'],
  [shared.MessageIdSchema, 'msg_'], [shared.ToolCallIdSchema, 'tc_'],
] as const;

describe('M1.1 public shared schemas', () => {
  it('preserves health exports and exposes the runtime limits', () => {
    expect(shared.APP_NAME).toBe('mini-agent-run');
    expect(shared.MAX_INLINE_TOOL_OUTPUT_BYTES).toBe(6144);
    expect(shared.MAX_ARTIFACT_SLICE_LINES).toBe(200);
    expect(shared.DEFAULT_MAX_STEPS).toBe(12);
    const health: shared.HealthResponse = { status: 'ok', service: shared.APP_NAME, timestamp, sqlite: 'ok' };
    expect(shared.HealthResponseSchema.parse(health)).toEqual(health);
    expect(shared.HealthResponseSchema.safeParse({ ...health, sqlite: 'error' }).success).toBe(false);
  });

  it.each([
    ['RunStatus', shared.RunStatusSchema, 'pending', 'unknown'],
    ['StopReason', shared.StopReasonSchema, 'server_restarted', 'pending'],
    ['PathType', shared.PathTypeSchema, 'dir', 'link'],
    ['TitleSource', shared.TitleSourceSchema, 'manual', 'mixed'],
    ['ToolMode', shared.ToolModeSchema, 'live', 'remote'],
    ['LogLevel', shared.LogLevelSchema, 'other', 'debug'],
    ['TaskOutcome', shared.TaskOutcomeSchema, 'unknown', 'running'],
    ['ArtifactContentType', shared.ArtifactContentTypeSchema, 'application/x-ndjson', 'text/html'],
    ['IsoDateTime', shared.IsoDateTimeSchema, timestamp, '2026-11-24'],
    ['NonBlankString', shared.NonBlankStringSchema, 'text', ' \t '],
    ['NonBlankPath', shared.NonBlankPathSchema, ' trace.json', ' \t '],
    ['Session', shared.SessionSchema, session, { ...session, titleSource: undefined }],
    ['CreateSessionRequest', shared.CreateSessionRequestSchema, { targetPath: ' trace.json' }, { targetPath: '' }],
    ['UpdateSessionRequest', shared.UpdateSessionRequestSchema, { title: 'Review' }, { title: ' ' }],
    ['SessionListItem', shared.SessionListItemSchema, { ...session, hasActiveRun: false, runCount: 0 },
      { ...session, hasActiveRun: false, runCount: -1 }],
    ['SessionDetail', shared.SessionDetailSchema, { session, hasActiveRun: false, runs: [run] },
      { session, hasActiveRun: false, runs: [{ ...run, lastSeq: -1 }] }],
    ['ToolCallRequest', shared.ToolCallRequestSchema, request, { ...request, arguments: [] }],
    ['ToolOutputSummary', shared.ToolOutputSummarySchema, summary, { ...summary, firstErrorLine: 0 }],
    ['PendingToolCall', shared.PendingToolCallSchema, pending, { ...pending, toolCallId: runId }],
    ['AgentError', shared.AgentErrorSchema, problem, { ...problem, code: ' ' }],
    ['AgentState', shared.AgentStateSchema, state, { ...state, maxSteps: 0 }],
    ['EvidenceRef', shared.EvidenceRefSchema, evidence, { ...evidence, endLine: 1 }],
    ['InvestigationConclusion', shared.InvestigationConclusionSchema, conclusion,
      { ...conclusion, recommendations: [' '] }],
    ['RunEventEnvelope', shared.RunEventEnvelopeSchema, event, { ...event, seq: 0 }],
    ['InvestigationRun', shared.InvestigationRunSchema, run, { ...run, errorCode: undefined }],
    ['CreateRunRequest', shared.CreateRunRequestSchema, { prompt: 'Review', maxSteps: 30 },
      { prompt: 'Review', maxSteps: 31 }],
    ['RetryRunRequest', shared.RetryRunRequestSchema, {}, { prompt: ' ' }],
    ['TraceFormat', shared.TraceFormatSchema, 'jsonl', 'xml'],
    ['TraceThreeState', shared.TraceThreeStateSchema, threeState, { ...threeState, toolErrorCount: -1 }],
    ['TraceAnomalies', shared.TraceAnomaliesSchema, anomalies,
      { ...anomalies, retryLoops: [{ toolName: 'trace', startStep: 0, endStep: 1, repeatCount: 1 }] }],
    ['TraceOverview', shared.TraceOverviewSchema,
      { file: ' trace.json', format: 'generic_json', byteSize: 0, lineCount: 0, stepCount: null,
        taskSummary: null, threeState, anomalies },
      { file: 'trace.json', format: 'generic_json', byteSize: 0, lineCount: 0, stepCount: -1,
        taskSummary: null, threeState, anomalies }],
    ['ArtifactMeta', shared.ArtifactMetaSchema,
      { id: artifactId, runId, sessionId, toolCallId, sourceTool: request.name, title: 'Output',
        contentType: 'text/plain', byteSize: 0, lineCount: 0, summary, createdAt: timestamp },
      { id: runId, runId, sessionId, toolCallId, sourceTool: request.name, title: 'Output',
        contentType: 'text/plain', byteSize: 0, lineCount: 0, summary, createdAt: timestamp }],
    ['FsBrowseEntry', shared.FsBrowseEntrySchema, entry, { ...entry, byteSize: -1 }],
    ['FsBrowseResponse', shared.FsBrowseResponseSchema,
      { currentPath: '/traces', parentPath: null, allowedRoots: ['/traces'], entries: [entry] },
      { currentPath: '/traces', parentPath: null, allowedRoots: [' '], entries: [entry] }],
    ['LogLine', shared.LogLineSchema, line, { ...line, lineNumber: 0 }],
    ['TextSliceResponse', shared.TextSliceResponseSchema, page, { ...page, nextOffsetLine: null }],
  ] as const)('validates %s', (_name, schema, valid, invalid) => {
    expect(schema.parse(valid)).toEqual(valid);
    expect(schema.safeParse(invalid).success).toBe(false);
  });

  it('keeps human text trimmed and file paths byte-for-byte intact', () => {
    expect(shared.CreateSessionRequestSchema.parse({ targetPath: ' trace.json', title: ' Review ' }))
      .toEqual({ targetPath: ' trace.json', title: 'Review' });
    expect(shared.FsBrowseEntrySchema.parse(entry).name).toBe(' trace.json');
    expect(shared.EvidenceRefSchema.parse(evidence)).toEqual(evidence);
  });

  it('honors retry defaults, sequence bounds and terminal pagination', () => {
    expect(shared.RetryRunRequestSchema.parse(undefined)).toEqual({});
    expect(shared.RetryRunRequestSchema.parse({ prompt: 'narrow down step 17' }))
      .toEqual({ prompt: 'narrow down step 17' });
    for (const seq of [0, -1, 1.25]) {
      expect(shared.RunEventEnvelopeSchema.safeParse({ ...event, seq }).success).toBe(false);
    }
    expect(shared.TextSliceResponseSchema.safeParse({ ...page, nextOffsetLine: 1 }).success).toBe(false);
    expect(shared.TextSliceResponseSchema.safeParse({ ...page, hasMore: false }).success).toBe(false);
    expect(shared.TextSliceResponseSchema.parse({ ...page, hasMore: false, nextOffsetLine: null }).hasMore)
      .toBe(false);
  });

  it('discriminates all message roles and evidence kinds', () => {
    const user = { id: messageId, content: '', createdAt: timestamp, role: 'user' };
    const tool = { ...user, role: 'toolResult', toolCallId, toolName: request.name, isError: false, durationMs: 0,
      artifactId, summary };
    for (const message of [user, assistant, tool]) expect(shared.AgentMessageSchema.parse(message)).toEqual(message);
    expect(shared.AgentMessageSchema.safeParse({ ...assistant, toolCalls: undefined }).success).toBe(false);
    expect(shared.AgentMessageSchema.safeParse({ ...tool, durationMs: -1 }).success).toBe(false);
    expect(shared.AgentMessageSchema.safeParse({ ...user, role: 'unknown' }).success).toBe(false);

    const fileStep = { kind: 'file_step', label: evidence.label, file: evidence.file, step: 0 };
    const artifactLine = { kind: 'artifact_line', label: evidence.label, artifactId, startLine: 1, endLine: 2 };
    expect(shared.EvidenceRefSchema.parse(fileStep)).toEqual(fileStep);
    expect(shared.EvidenceRefSchema.parse(artifactLine)).toEqual(artifactLine);
    expect(shared.EvidenceRefSchema.safeParse({ ...artifactLine, startLine: 3 }).success).toBe(false);
  });

  it.each([
    [{ type: 'agent_start', sessionId, prompt: 'Review', modelId: 'example-model', maxSteps: 1 }, { maxSteps: 0 }],
    [{ type: 'turn_start', step: 1 }, { step: 0 }],
    [{ type: 'message_start', messageId, role: 'assistant' }, { role: 'user' }],
    [{ type: 'message_update', messageId, deltaType: 'text_delta', delta: 'part' }, { deltaType: 'done' }],
    [{ type: 'message_end', message: assistant }, { message: { ...assistant, role: 'user' } }],
    [{ type: 'tool_execution_start', step: 1, toolCallId, toolName: request.name, arguments: {} }, { step: 0 }],
    [{ type: 'tool_execution_update', toolCallId, toolName: request.name, elapsedMs: 0 }, { elapsedMs: -1 }],
    [{ type: 'tool_execution_end', step: 1, toolCallId, toolName: request.name, isError: false,
      durationMs: 0, preview: '' }, { durationMs: -1 }],
    [{ type: 'turn_end', step: 1, toolCallCount: 0 }, { toolCallCount: -1 }],
    [{ type: 'agent_end', status: 'completed', stopReason: 'completed', durationMs: 0, conclusion },
      { status: 'running' }],
  ] as const)('validates event variant %#', (valid, invalid) => {
    expect(shared.AgentEventSchema.parse(valid)).toEqual(valid);
    expect(shared.AgentEventSchema.safeParse({ ...valid, ...invalid }).success).toBe(false);
  });

  it.each(idSchemas.map(([schema, prefix]) => [prefix, schema] as const))(
    'requires a nonempty, whitespace-free ID after prefix %s',
    (prefix, schema) => {
      expect(schema.safeParse(prefix).success).toBe(false);
      expect(schema.safeParse(prefix + ' bad').success).toBe(false);
      expect(schema.safeParse(prefix + 'ok\n').success).toBe(false);
      expect(schema.safeParse('foreign_ok').success).toBe(false);
    },
  );

  it('checks generated envelope, prefix and summary boundaries', () => {
    const suffix = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);
    const validSeq = fc.integer({ min: 1, max: 100_000 });
    const invalidSeq = fc.oneof(
      fc.integer({ min: -100_000, max: 0 }),
      validSeq.map((value) => value + 0.5),
    );

    fc.assert(fc.property(suffix, validSeq, invalidSeq, fc.nat(100_000), (id, seq, invalid, bytes) => {
      for (const [schema, prefix] of idSchemas) {
        expect(schema.parse(prefix + id)).toBe(prefix + id);
        expect(schema.safeParse('foreign_' + id).success).toBe(false);
      }
      const envelope = { ...event, runId: 'run_' + id, seq };
      expect(shared.RunEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(shared.RunEventEnvelopeSchema.safeParse({ ...envelope, seq: invalid }).success).toBe(false);
      expect(shared.ToolOutputSummarySchema.safeParse({ ...summary, byteSize: bytes }).success).toBe(true);
      expect(shared.ToolOutputSummarySchema.safeParse({ ...summary, byteSize: -bytes - 1 }).success).toBe(false);
    }), { seed: 20261124, numRuns: 100 });
  });
});
