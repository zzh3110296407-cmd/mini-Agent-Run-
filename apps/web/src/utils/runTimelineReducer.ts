import {
  ArtifactIdSchema, TraceAnomaliesSchema, type AgentError, type AgentEvent, type ArtifactId,
  type InvestigationConclusion, type InvestigationRun, type RunEventEnvelope, type RunStatus, type ToolCallId,
  type ToolOutputSummary,
} from '@mini-agent-run/shared';

export type ToolFileTarget = { file?: string; line?: number; step?: number };
export type ToolCallViewItem = {
  key: number;
  toolCallId: ToolCallId;
  toolName: string;
  step: number;
  arguments: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  elapsedMs: number;
  durationMs?: number;
  progressMessage?: string;
  preview?: string;
  artifactId?: ArtifactId;
  summary?: ToolOutputSummary;
  fileTarget?: ToolFileTarget;
};
export type ActiveTool = Pick<ToolCallViewItem, 'toolCallId' | 'toolName' | 'step' | 'elapsedMs' | 'progressMessage'>;
export type JumpTarget = Pick<ToolCallViewItem, 'key' | 'toolCallId' | 'step' | 'artifactId' | 'fileTarget'> & { line?: number };
export type HighSignalTargets = { firstError: JumpTarget | null; retryLoop: JumpTarget | null; slowTool: JumpTarget | null };

type AssistantText = { id: string; text: string };
export type RunTurnViewModel = {
  run: InvestigationRun;
  lastSeq: number;
  currentStep: number;
  streamText: string;
  activeTool: ActiveTool | null;
  toolCalls: ToolCallViewItem[];
  conclusion: InvestigationConclusion | null;
  error: AgentError | null;
  highSignals: HighSignalTargets;
  messages: AssistantText[];
};

export function isActiveRunStatus(status: RunStatus): boolean {
  return status === 'pending' || status === 'running';
}

function fileFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function naturalNumber(value: unknown, minimum: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function fileFromArguments(args: Record<string, unknown>): ToolFileTarget | undefined {
  const file = fileFrom(args.file);
  const line = naturalNumber(args.startLine, 1);
  const step = naturalNumber(args.startStep, 0);
  if (file === undefined && line === undefined && step === undefined) return undefined;
  return { file, line, step };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function inspectPreview(tool: ToolCallViewItem) {
  if (tool.toolName !== 'inspect_trace' || !tool.preview) return;
  try {
    const result = record(JSON.parse(tool.preview));
    const anomalies = record(result?.anomalies);
    if (!anomalies) return;
    const firstError = TraceAnomaliesSchema.shape.firstError.safeParse(anomalies.firstError);
    const retryLoops = TraceAnomaliesSchema.shape.retryLoops.safeParse(anomalies.retryLoops);
    const slowSpans = TraceAnomaliesSchema.shape.slowSpans.safeParse(anomalies.slowSpans);
    return {
      file: fileFrom(result?.file) ?? tool.fileTarget?.file,
      firstError: firstError.success ? firstError.data : null,
      retryLoop: retryLoops.success ? retryLoops.data[0] : undefined,
      slowSpan: slowSpans.success ? slowSpans.data[0] : undefined,
    };
  } catch {
    // Event previews may end in the middle of JSON.
    return undefined;
  }
}

function jump(tool: ToolCallViewItem, line?: number): JumpTarget {
  const { key, toolCallId, step, artifactId, fileTarget } = tool;
  return { key, toolCallId, step, artifactId, fileTarget, line };
}

function inspectedJump(tool: ToolCallViewItem, file: string | undefined, line?: number, step?: number): JumpTarget {
  const { key, toolCallId } = tool;
  return { key, toolCallId, step: tool.step, fileTarget: {
    ...(file === undefined ? {} : { file }),
    ...(line === undefined ? {} : { line }),
    ...(step === undefined ? {} : { step }),
  } };
}

function deriveHighSignals(tools: readonly ToolCallViewItem[]): HighSignalTargets {
  let firstError: JumpTarget | null = null;
  let retryLoop: JumpTarget | null = null;
  let slowTool: JumpTarget | null = null;
  let previous: ToolCallViewItem | undefined;
  let slowest = 999;
  const inspected = tools.map((tool) => ({ tool, report: inspectPreview(tool) }));
  for (const { tool } of inspected) {
    const line = tool.summary?.firstErrorLine ?? undefined;
    if (firstError === null && (line !== undefined || tool.status === 'error')) firstError = jump(tool, line);
    if (retryLoop === null && previous?.toolName === tool.toolName) retryLoop = jump(tool);
    if (tool.durationMs !== undefined && tool.durationMs > slowest) {
      slowTool = jump(tool);
      slowest = tool.durationMs;
    }
    previous = tool;
  }
  for (const { tool, report } of inspected) {
    if (!report) continue;
    if (firstError === null && report.firstError) {
      firstError = inspectedJump(tool, report.file, report.firstError.line, report.firstError.step);
    }
    if (retryLoop === null && report.retryLoop) {
      retryLoop = inspectedJump(tool, report.file, undefined, report.retryLoop.startStep);
    }
    if (slowTool === null && report.slowSpan) {
      slowTool = inspectedJump(tool, report.file, undefined, report.slowSpan.step);
    }
  }
  return { firstError, retryLoop, slowTool };
}

function textChange(model: RunTurnViewModel, id: string, text: string, append: boolean) {
  const index = model.messages.findIndex((message) => message.id === id);
  const previous = model.messages[index];
  const message = { id, text: append ? (previous?.text ?? '') + text : text };
  const messages = previous ? model.messages.map((value, position) => position === index ? message : value) : [...model.messages, message];
  return { ...model, messages, streamText: messages.map((value) => value.text).filter((value) => value !== '').join('\n\n') };
}

type ToolEvent = Extract<AgentEvent, { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }>;

function applyTool(model: RunTurnViewModel, event: ToolEvent): RunTurnViewModel {
  const { toolCallId, toolName } = event;
  const toolCalls = [...model.toolCalls];
  const activeTool = model.activeTool;
  if (event.type === 'tool_execution_start') {
    const step = event.step;
    const artifact = ArtifactIdSchema.safeParse(event.arguments.artifactId);
    toolCalls.push({
      key: model.lastSeq, toolCallId, toolName, step, arguments: event.arguments, status: 'running', elapsedMs: 0,
      artifactId: artifact.success ? artifact.data : undefined, fileTarget: fileFromArguments(event.arguments),
    });
    return { ...model, activeTool: { toolCallId, toolName, step, elapsedMs: 0 }, toolCalls, highSignals: deriveHighSignals(toolCalls) };
  }

  const step = event.type === 'tool_execution_end' ? event.step : activeTool?.step;
  const index = toolCalls.findIndex((tool) => tool.toolCallId === toolCallId && tool.step === step && tool.status === 'running');
  const previous = toolCalls[index];
  if (event.type === 'tool_execution_update') {
    if (!previous || activeTool?.toolCallId !== toolCallId) return model;
    const elapsedMs = Math.max(previous.elapsedMs, event.elapsedMs);
    const progressMessage = event.progressMessage ?? previous.progressMessage;
    toolCalls[index] = { ...previous, elapsedMs, progressMessage };
    return { ...model, toolCalls, activeTool: { ...activeTool, elapsedMs, progressMessage } };
  }

  const current: ToolCallViewItem = {
    ...previous, key: previous?.key ?? model.lastSeq, toolCallId, toolName, step: event.step, arguments: previous?.arguments ?? {},
    elapsedMs: event.durationMs, durationMs: event.durationMs, status: event.isError ? 'error' : 'done',
    preview: event.preview, artifactId: event.artifactId ?? previous?.artifactId, summary: event.summary,
  };
  if (previous) toolCalls[index] = current;
  else toolCalls.push(current);
  return {
    ...model, toolCalls, highSignals: deriveHighSignals(toolCalls),
    activeTool: activeTool?.toolCallId === toolCallId && activeTool.step === event.step ? null : activeTool,
  };
}

export function applyRunEventEnvelope(model: RunTurnViewModel, envelope: RunEventEnvelope): RunTurnViewModel {
  const { event, seq, timestamp } = envelope;
  if (envelope.runId !== model.run.id || seq <= model.lastSeq || !isActiveRunStatus(model.run.status)) return model;
  if (event.type === 'agent_start' && event.sessionId !== model.run.sessionId) return model;
  const run = { ...model.run, lastSeq: seq };
  const next = { ...model, run, lastSeq: seq };
  switch (event.type) {
    case 'agent_start':
      return { ...next, run: { ...run, status: 'running', startedAt: run.startedAt ?? timestamp, modelId: event.modelId, maxSteps: event.maxSteps } };
    case 'turn_start':
    case 'turn_end': {
      const currentStep = Math.max(model.currentStep, event.step);
      return { ...next, currentStep, run: { ...run, stepCount: currentStep } };
    }
    case 'message_start':
      return model.messages.some(({ id }) => id === event.messageId) ? next : textChange(next, event.messageId, '', false);
    case 'message_update':
      return event.deltaType === 'text_delta' ? textChange(next, event.messageId, event.delta, true) : next;
    case 'message_end':
      return textChange(next, event.message.id, event.message.content, false);
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      return applyTool(next, event);
    case 'agent_end':
      return {
        ...next,
        run: {
          ...run, status: event.status, stopReason: event.stopReason, endedAt: timestamp, durationMs: event.durationMs,
          finalAnswer: event.finalAnswer ?? null, conclusion: event.conclusion ?? null,
          errorCode: event.error?.code ?? null, errorMessage: event.error?.message ?? null,
        },
        activeTool: null, streamText: event.finalAnswer ?? next.streamText, conclusion: event.conclusion ?? null, error: event.error ?? null,
      };
  }
}

export function createRunTurnViewModel(run: InvestigationRun, events: readonly RunEventEnvelope[] = []): RunTurnViewModel {
  const initial: RunTurnViewModel = {
    run: { ...run, status: isActiveRunStatus(run.status) ? run.status : 'pending' },
    lastSeq: 0, currentStep: run.stepCount, streamText: '', activeTool: null, toolCalls: [], conclusion: null, error: null,
    highSignals: { firstError: null, retryLoop: null, slowTool: null }, messages: [],
  };
  const replay = events.reduce(applyRunEventEnvelope, initial);
  if (isActiveRunStatus(run.status)) return replay;
  return {
    ...replay, run, activeTool: null, streamText: run.finalAnswer ?? replay.streamText,
    conclusion: run.conclusion ?? replay.conclusion,
    error: run.errorCode && run.errorMessage ? { code: run.errorCode, message: run.errorMessage } : replay.error,
  };
}
