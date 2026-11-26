import type { InvestigationConclusion, LogLine } from '@mini-agent-run/shared';

type ErrorSummaryContext = {
  sourceMode: 'file' | 'artifact';
  filePath: string | null;
  directoryPath?: string;
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

const windowsVolume = /^(?:[a-z]:|\/\/[^/]+\/[^/]+)/u;

function resolveFileKey(path: string, directory: string, windows: boolean): string {
  let resolved = path;
  if (windows && path.startsWith('/') && !path.startsWith('//')) {
    resolved = (windowsVolume.exec(directory)?.[0] ?? '') + path;
  } else if (directory && !path.startsWith('/') && !(windows && windowsVolume.test(path))) {
    resolved = directory.replace(/\/+$/u, '') + '/' + path;
  }

  const volume = windows ? windowsVolume.exec(resolved)?.[0] ?? '' : '';
  const tail = resolved.slice(volume.length);
  const rooted = tail.startsWith('/') || volume.startsWith('//');
  const segments: string[] = [];
  for (const segment of tail.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') segments.push(segment);
    else if (segments.length && segments.at(-1) !== '..') segments.pop();
    else if (!rooted) segments.push(segment);
  }
  return volume + (rooted ? '/' : '') + segments.join('/');
}

function matchesFile(path: string | null, file: string, directoryPath?: string): boolean {
  if (path === null) return false;
  const windows = /^(?:[a-z]:|[\\/]{2})/iu.test(directoryPath ?? path);
  const normalize = (value: string) => windows ? value.replaceAll('\\', '/').toLowerCase() : value;
  const directory = normalize(directoryPath ?? '');
  const actual = resolveFileKey(normalize(path), directory, windows);
  const observed = normalize(file);
  const name = observed.replace(/^(?:\.\/)+/u, '');
  return actual === resolveFileKey(observed, directory, windows)
    || (!name.includes('/') && actual.endsWith('/' + name));
}

export function resolveErrorLineSummary(
  row: LogLine, context: ErrorSummaryContext,
): { text: string; source: 'ai' | 'extracted' } {
  const { artifactId, conclusions, directoryPath, filePath, singleFile, sourceMode } = context;
  for (let index = conclusions.length - 1; index >= 0; index--) {
    const exact = conclusions[index]?.errorSummaries?.find((entry) => entry.line === row.lineNumber
      && (sourceMode === 'artifact'
        ? artifactId !== null && entry.artifactId === artifactId
        : entry.artifactId === undefined
          && (entry.file === undefined ? singleFile === true : matchesFile(filePath, entry.file, directoryPath))));
    if (exact) return { text: exact.summary, source: 'ai' };
  }
  for (let index = conclusions.length - 1; index >= 0; index--) {
    const evidence = conclusions[index]?.evidence.find((ref) => ref.kind !== 'file_step'
      && row.lineNumber >= ref.startLine && row.lineNumber <= (ref.endLine ?? ref.startLine)
      && (ref.kind === 'artifact_line'
        ? sourceMode === 'artifact' && ref.artifactId === artifactId
        : sourceMode === 'file' && matchesFile(filePath, ref.file, directoryPath)));
    if (evidence) return { text: evidence.label, source: 'ai' };
  }
  return { text: extractStructuredErrorSummary(row.text), source: 'extracted' };
}
