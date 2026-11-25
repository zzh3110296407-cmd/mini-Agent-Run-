import type { ToolExecutionContext, TraceWorkspacePort } from '@mini-agent-run/agent';
import { asObject } from '../trace-analyzer.js';
import { checkAbort, errorCode, ToolError } from '../tool-error.js';

type Scenario = 'healthy' | 'slow' | 'error';
export interface DiagnosticArgs {
  scenario?: Scenario;
  delayMs?: number;
  progressIntervalMs?: number;
}

function scenario(value: unknown): Scenario | undefined {
  return value === 'healthy' || value === 'slow' || value === 'error' ? value : undefined;
}

function milliseconds(value: unknown, max: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined;
}

function waitForProbe(delay: number, interval: number, progressMessage: string, ctx: ToolExecutionContext) {
  checkAbort(ctx.signal);
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delay);
    const tick = setInterval(() => {
      try {
        ctx.onProgress?.({ elapsedMs: Date.now() - started, progressMessage });
      } catch (error) {
        cleanup();
        reject(error);
      }
    }, interval);
    function cleanup() {
      clearTimeout(timer);
      clearInterval(tick);
      ctx.signal.removeEventListener('abort', onAbort);
    }
    function onAbort() {
      cleanup();
      reject(new ToolError('TOOL_ABORTED', 'The tool was stopped.'));
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runtimeDiagnostics(
  workspace: TraceWorkspacePort, args: DiagnosticArgs, ctx: ToolExecutionContext,
  defaults: { diagnosticsDefaultDelayMs?: number; diagnosticsProgressIntervalMs?: number },
) {
  const { allowedRoots } = ctx;
  if (ctx.toolMode === 'live') {
    const target = await workspace.resolveTarget(allowedRoots);
    const listing = await workspace.listFiles(allowedRoots);
    return {
      status: 'healthy', mode: 'live', scenario: 'healthy', accessible: true, pathType: target.kind,
      fileCount: listing.entries.length, truncated: listing.truncated,
      runtime: { node: process.versions.node, platform: process.platform },
    };
  }

  const fixtureName = 'diagnostics.fixture.json';
  let fixture;
  if (workspace.binding.pathType === 'dir' || workspace.binding.targetPath.split(/[/\\]/).at(-1) === fixtureName) {
    try {
      const input = await workspace.readFile(fixtureName, allowedRoots, { maxBytes: 16 * 1024 });
      const payload: unknown = JSON.parse(input.content);
      fixture = asObject(payload);
      if (!fixture) throw new ToolError('INVALID_DIAGNOSTIC_FIXTURE', 'The diagnostic fixture must be a JSON object.');
    } catch (error) {
      if (error instanceof SyntaxError) throw new ToolError('INVALID_DIAGNOSTIC_FIXTURE', 'The diagnostic fixture is invalid.');
      if (errorCode(error) !== 'PATH_NOT_FOUND') throw error;
    }
  } else {
    await workspace.resolveTarget(allowedRoots);
  }
  const selected = args.scenario ?? scenario(fixture?.defaultScenario) ?? 'healthy';
  if (selected === 'error') {
    const error = asObject(fixture?.error);
    const code = typeof error?.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.errorCode)
      ? error.errorCode : 'MOCK_UPSTREAM_TIMEOUT';
    throw new ToolError(code, 'The simulated runtime diagnostic failed.');
  }
  if (selected === 'slow') {
    const timing = asObject(fixture?.slow);
    const delay = args.delayMs ?? milliseconds(timing?.delayMs, 30_000)
      ?? milliseconds(defaults.diagnosticsDefaultDelayMs, 30_000) ?? 4000;
    const interval = args.progressIntervalMs ?? milliseconds(timing?.progressIntervalMs, 30_000)
      ?? milliseconds(defaults.diagnosticsProgressIntervalMs, 30_000) ?? 500;
    const message = typeof timing?.progressMessage === 'string' ? timing.progressMessage.slice(0, 200)
      : 'Running mock runtime diagnostics...';
    await waitForProbe(delay, interval, message, ctx);
  }
  return { status: 'healthy', mode: 'mock', scenario: selected };
}
