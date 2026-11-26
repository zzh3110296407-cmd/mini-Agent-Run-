import type { InvestigationConclusion, LogLine } from '@mini-agent-run/shared';

type ErrorSummaryContext = {
  sourceMode: 'file' | 'artifact';
  filePath: string | null;
  artifactId: string | null;
  singleFile?: boolean;
  conclusions: readonly InvestigationConclusion[];
};

const unspecified = '日志未提供具体错误信息';
const timestamp = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/iu;
const severity = /^(?:\[(?:ERROR|ERR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)\]|(?:ERROR|ERR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG|TRACE)(?=\s|:|$))\s*:?\s*/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonblank(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function extractStructuredErrorSummary(rawText: string): string {
  const text = rawText.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      const entry = record(parsed);
      if (!entry) return unspecified;
      const tool = nonblank(entry.toolName) ?? nonblank(entry.tool);
      const message = nonblank(entry.errorMessage) ?? nonblank(record(entry.error)?.message)
        ?? nonblank(entry.error) ?? nonblank(entry.message) ?? nonblank(entry.reason);
      if (message) return tool ? tool + ' · ' + message : message;

      const step = typeof entry.step === 'number' && Number.isInteger(entry.step) && entry.step >= 0
        ? 'Step #' + entry.step : undefined;
      return [tool, nonblank(entry.type), step].filter(Boolean).join(' · ') || unspecified;
    } catch {
      if (text.startsWith('{')) return unspecified;
    }
  }
  return text.replace(timestamp, '').replace(severity, '').trim() || unspecified;
}

function matchesFile(path: string | null, file: string): boolean {
  if (path === null) return false;
  const windows = /^(?:[a-z]:|\\\\)/iu.test(path);
  const normalize = (value: string) => {
    const normalized = value.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '');
    return windows ? normalized.toLowerCase() : normalized;
  };
  const actual = normalize(path);
  const observed = normalize(file);
  return actual === observed || actual.split('/').at(-1) === observed.split('/').at(-1);
}

export function resolveErrorLineSummary(
  row: LogLine, context: ErrorSummaryContext,
): { text: string; source: 'ai' | 'extracted' } {
  const { artifactId, conclusions, filePath, singleFile, sourceMode } = context;
  for (let index = conclusions.length - 1; index >= 0; index--) {
    const exact = conclusions[index]?.errorSummaries?.find((entry) => entry.line === row.lineNumber
      && (sourceMode === 'artifact'
        ? artifactId !== null && entry.artifactId === artifactId
        : entry.artifactId === undefined && (entry.file === undefined ? singleFile === true : matchesFile(filePath, entry.file))));
    if (exact) return { text: exact.summary, source: 'ai' };
  }
  for (let index = conclusions.length - 1; index >= 0; index--) {
    const evidence = conclusions[index]?.evidence.find((ref) => ref.kind !== 'file_step'
      && row.lineNumber >= ref.startLine && row.lineNumber <= (ref.endLine ?? ref.startLine)
      && (ref.kind === 'artifact_line'
        ? sourceMode === 'artifact' && ref.artifactId === artifactId
        : sourceMode === 'file' && matchesFile(filePath, ref.file)));
    if (evidence) return { text: evidence.label, source: 'ai' };
  }
  return { text: extractStructuredErrorSummary(row.text), source: 'extracted' };
}
