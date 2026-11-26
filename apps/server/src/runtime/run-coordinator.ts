import { runDebugInvestigation } from '@mini-agent-run/debug-agent';
import {
  DEFAULT_MAX_STEPS, type AgentEvent, type CreateRunRequest, type InvestigationRun, type RetryRunRequest,
  type RunEventEnvelope, type RunStepLimit, type Session,
} from '@mini-agent-run/shared';
import { createToolRegistry } from '@mini-agent-run/tools';
import {
  isActiveRun, RunCoordinatorError, type AgentEndEvent, type ResolvedLlmProvider, type RunCoordinatorOptions,
} from './ports.js';
import { createRunRedactor, redactArtifactStore, redactEvent } from './run-redaction.js';

type Delta = Extract<AgentEvent, { type: 'message_update' }>;
type RequestOptions = { apiKeyOverride?: string };
const legacyDefaultMaxSteps = 12;

interface ActiveRun {
  controller: AbortController;
  flush: () => void;
  finished: Promise<void>;
}

interface Subscriber {
  push(envelope: RunEventEnvelope): void;
  close(): void;
}

export interface RunStream extends AsyncIterable<RunEventEnvelope> {
  close(): void;
}

const noSecrets = createRunRedactor([]);

export function createRunCoordinator({
  store, artifactStore, createWorkspace, resolveProvider, resolveAllowedRoots, toolMode,
  coalesceWindowMs = 100, coalesceMaxChars = 256, diagnosticsDefaultDelayMs, diagnosticsProgressIntervalMs,
  contextWindowTokens,
}: RunCoordinatorOptions) {
  const activeRuns = new Map<string, ActiveRun>();
  const subscribers = new Map<string, Set<Subscriber>>();

  function getRun(runId: string) {
    const run = store.getRun(runId);
    if (!run) throw new RunCoordinatorError('RUN_NOT_FOUND');
    return run;
  }

  function publish(envelope: RunEventEnvelope) {
    for (const subscriber of subscribers.get(envelope.runId) ?? []) subscriber.push(envelope);
  }

  function finish(runId: string, event: AgentEndEvent) {
    const result = store.finishRun(runId, new Date().toISOString(), event);
    if (result.updated) publish(result.envelope);
  }

  function stopped(runId: string, durationMs = 0) {
    finish(runId, { type: 'agent_end', status: 'stopped', stopReason: 'user_abort', durationMs });
  }

  async function executeRun(run: InvestigationRun, session: Session, llm: ResolvedLlmProvider, active: ActiveRun) {
    const { signal } = active.controller;
    const redact = llm.redactor ?? noSecrets;
    const start = performance.now();
    let ended = false;
    let writeFailed = false;
    let buffered: Delta | undefined;
    let deltaTail: Delta | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function append(event: Exclude<AgentEvent, AgentEndEvent>) {
      for (const envelope of store.appendEvents(run.id, [event])) publish(envelope);
    }

    function flush() {
      clearTimeout(timer);
      timer = undefined;
      const delta = buffered;
      buffered = undefined;
      if (delta) append(delta);
    }

    function flushTail() {
      const delta = deltaTail;
      deltaTail = undefined;
      if (delta && delta.delta) {
        if (delta.deltaType === 'text_delta' && buffered) buffered.delta += redact.text(delta.delta);
        else append({ ...redactEvent(delta, redact), delta: redact.text(delta.delta) });
      }
    }

    function onEvent(event: AgentEvent) {
      if (event.type === 'message_update') {
        if (deltaTail && (deltaTail.messageId !== event.messageId || deltaTail.deltaType !== event.deltaType
          || deltaTail.toolCallId !== event.toolCallId)) {
          flushTail();
          flush();
        }
        const { safe, tail } = redact.splitDelta((deltaTail?.delta ?? '') + event.delta);
        const metadata = redactEvent(event, redact);
        deltaTail = tail ? { ...event, delta: tail } : undefined;
        if (event.deltaType === 'toolcall_delta') {
          flush();
          if (safe || !event.delta) append({ ...metadata, delta: safe });
          return;
        }
        if (buffered && buffered.messageId !== event.messageId) flush();
        if (safe) {
          if (buffered) buffered.delta += safe;
          else buffered = { ...metadata, delta: safe };
          if (buffered.delta.length >= coalesceMaxChars) flush();
          else timer ??= setTimeout(() => {
            try {
              flush();
            } catch {
              writeFailed = true;
              active.controller.abort();
            }
          }, coalesceWindowMs);
        }
        return;
      }

      flushTail();
      flush();
      const sanitized = redactEvent(event, redact);
      if (sanitized.type === 'agent_end') {
        if (writeFailed) throw new Error('Could not persist an event.');
        finish(run.id, sanitized);
        ended = true;
      } else append(sanitized);
    }

    active.flush = () => {
      flushTail();
      flush();
    };
    try {
      if (signal.aborted) {
        stopped(run.id);
        return;
      }
      if (!store.markRunning(run.id, new Date().toISOString())) return;
      const workspace = createWorkspace(session);
      const safeArtifacts = redactArtifactStore(artifactStore, redact, signal);
      const tools = createToolRegistry({
        toolMode, artifactStore: safeArtifacts, workspace, diagnosticsDefaultDelayMs, diagnosticsProgressIntervalMs,
      });
      await runDebugInvestigation({
        runId: run.id, sessionId: session.id, prompt: run.prompt, provider: llm.provider, model: llm.modelId,
        providerName: llm.providerName, tools, maxSteps: run.maxSteps, pathType: session.pathType,
        targetLabel: redact.text(session.title), targetPath: workspace.binding.targetPath, allowedRoots: resolveAllowedRoots(),
        artifactStore: safeArtifacts, toolMode, signal, onEvent, priorRuns: store.listPriorSessionRuns(session.id),
        contextWindowTokens,
      });
      if (!ended) throw new Error('The run did not persist an ending.');
    } catch {
      try {
        flushTail();
        flush();
      } finally {
        const durationMs = Math.floor(performance.now() - start);
        if (signal.aborted && !writeFailed) stopped(run.id, durationMs);
        else finish(run.id, {
          type: 'agent_end', status: 'failed', stopReason: 'error', durationMs,
          error: { code: 'AGENT_EXECUTION_ERROR', message: 'The agent run could not complete.' },
        });
      }
    } finally {
      clearTimeout(timer);
      activeRuns.delete(run.id);
    }
  }

  function schedule(session: Session, prompt: string, maxSteps: RunStepLimit, llm: ResolvedLlmProvider, retryOfRunId?: string) {
    const redact = llm.redactor ?? noSecrets;
    const run = store.createRun({
      sessionId: session.id, prompt: redact.text(prompt), maxSteps, toolMode, retryOfRunId,
      modelId: redact.text(llm.modelId), modelProvider: redact.text(llm.providerName),
    });
    const active: ActiveRun = { controller: new AbortController(), flush: () => {}, finished: Promise.resolve() };
    activeRuns.set(run.id, active);
    active.finished = new Promise<void>((resolve) => setImmediate(resolve)).then(() => executeRun(run, session, llm, active));
    // A database failure during finalization must not become an unhandled rejection.
    void active.finished.catch(() => {});
    return run;
  }

  function stop(active: ActiveRun) {
    if (active.controller.signal.aborted) return;
    try {
      active.flush();
    } finally {
      active.controller.abort('user_abort');
    }
  }

  function subscribeRunStream(runId: string, afterSeq: number): RunStream {
    getRun(runId);
    const group = subscribers.get(runId) ?? new Set<Subscriber>();
    subscribers.set(runId, group);
    let queued: RunEventEnvelope[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let closed = false;

    function detach() {
      group.delete(subscriber);
      if (group.size === 0 && subscribers.get(runId) === group) subscribers.delete(runId);
      wake?.();
    }

    const subscriber: Subscriber = {
      close,
      push(envelope) {
        queued.push(envelope);
        if (envelope.event.type === 'agent_end') {
          ended = true;
          detach();
        } else wake?.();
      },
    };
    function close() {
      closed = true;
      queued = [];
      detach();
    }

    group.add(subscriber);
    let history: RunEventEnvelope[];
    try {
      history = store.listRunEvents(runId, afterSeq);
      if (!isActiveRun(getRun(runId).status)) {
        ended = true;
        detach();
      }
    } catch (error) {
      close();
      throw error;
    }

    return {
      close,
      async *[Symbol.asyncIterator]() {
        let lastSeq = afterSeq;
        try {
          let frames = history;
          while (!closed) {
            for (const frame of frames) {
              if (closed) return;
              if (frame.seq <= lastSeq) continue;
              lastSeq = frame.seq;
              yield frame;
              if (frame.event.type === 'agent_end') return;
            }
            if (!queued.length) {
              if (ended) return;
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = undefined;
            }
            frames = queued;
            queued = [];
          }
        } finally {
          close();
        }
      },
    };
  }

  return {
    get activeRunCount() { return activeRuns.size; },
    get subscriberCount() {
      let count = 0;
      for (const group of subscribers.values()) count += group.size;
      return count;
    },
    startRun(sessionId: string, input: CreateRunRequest, options: RequestOptions = {}) {
      const session = store.getSession(sessionId);
      if (!session) throw new RunCoordinatorError('SESSION_NOT_FOUND');
      const llm = resolveProvider(options.apiKeyOverride);
      return schedule(session, input.prompt, input.maxSteps ?? DEFAULT_MAX_STEPS, llm);
    },
    retryRun(runId: string, input: RetryRunRequest, options: RequestOptions = {}) {
      const source = getRun(runId);
      if (isActiveRun(source.status)) throw new RunCoordinatorError('RUN_STILL_ACTIVE');
      if (source.status === 'completed') throw new RunCoordinatorError('RUN_NOT_RETRYABLE');
      const session = store.getSession(source.sessionId);
      if (!session) throw new RunCoordinatorError('SESSION_NOT_FOUND');
      const llm = resolveProvider(options.apiKeyOverride);
      const inheritedLimit = source.stopReason === 'max_steps' && source.maxSteps === legacyDefaultMaxSteps
        ? DEFAULT_MAX_STEPS : source.maxSteps;
      const limit = input.maxSteps === undefined ? inheritedLimit : input.maxSteps;
      return schedule(session, input.prompt ?? source.prompt, limit, llm, runId);
    },
    getRunDetail(runId: string) {
      return { run: getRun(runId), events: store.listRunEvents(runId) };
    },
    stopRun(runId: string) {
      const { status } = getRun(runId);
      if (!isActiveRun(status)) return { runId, status, alreadyTerminal: true } as const;
      const active = activeRuns.get(runId);
      if (active) stop(active);
      else stopped(runId);
      return { runId, status: 'stopping' } as const;
    },
    subscribeRunStream,
    async shutdown() {
      const running = [...activeRuns.values()];
      for (const active of running) {
        try { stop(active); } catch { /* Still wait for abort to finish. */ }
      }
      await Promise.allSettled(running.map(({ finished }) => finished));
      for (const group of subscribers.values()) for (const subscriber of group) subscriber.close();
    },
  };
}
