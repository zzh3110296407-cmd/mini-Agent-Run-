import type { ToolExecutionContext, TraceWorkspacePort } from '@mini-agent-run/agent';
import type { LogLevel } from '@mini-agent-run/shared';
import { setImmediate } from 'node:timers/promises';
import { traceLines } from '../sanitize.js';
import { compileSearchPattern, containsQuery } from '../search-pattern.js';
import { checkAbort, errorCode, ToolError } from '../tool-error.js';
import { classifyTraceLine, loadTrace } from '../trace-analyzer.js';
import { truncateUtf8Safe } from '../utf8.js';

interface SearchArgs {
  query?: string;
  regex?: string;
  file?: string;
  level?: LogLevel;
  contextLines?: number;
  maxMatches?: number;
}

type Preview = { lineNumber: number; text: string };
type Match = Preview & { file: string; level: LogLevel; contextBefore: Preview[]; contextAfter: Preview[] };

export async function searchLogs(
  workspace: TraceWorkspacePort, args: SearchArgs, { allowedRoots, signal }: ToolExecutionContext,
) {
  if (args.query === undefined && args.regex === undefined) {
    throw new ToolError('INVALID_TOOL_ARGUMENTS', 'A query or regular expression is required.');
  }
  const regex = args.regex === undefined ? undefined : compileSearchPattern(args.regex);
  const query = args.query?.toLowerCase();
  const contextLines = args.contextLines ?? 0;
  const maxMatches = args.maxMatches ?? 50;
  const singleFile = args.file !== undefined || workspace.binding.pathType === 'file';
  const listing = singleFile ? undefined : await workspace.listFiles(allowedRoots);
  const paths = listing ? listing.entries.map(({ relativePath }) => relativePath) : [args.file];
  const matches: Match[] = [];
  const warnings: { file: string; code: string }[] = [];
  let totalMatches = 0;
  let filesSearched = 0;

  for (const path of paths) {
    checkAbort(signal);
    const file = await workspace.readFile(path, allowedRoots);
    checkAbort(signal);
    let safeContent: string;
    try {
      safeContent = loadTrace(file.content, file.relativePath).sanitized;
    } catch (error) {
      if (singleFile || errorCode(error) !== 'UNSANITIZABLE_TRACE_JSON') throw error;
      warnings.push({ file: file.relativePath, code: 'UNSANITIZABLE_TRACE_JSON' });
      continue;
    }
    filesSearched++;
    const recent: Preview[] = [];
    let pending: Match[] = [];
    for (const { line, text } of traceLines(safeContent)) {
      if ((line - 1) % 500 === 0) {
        await setImmediate();
        checkAbort(signal);
      }
      const preview: Preview = { lineNumber: line, text: truncateUtf8Safe(text, 1024).text };
      for (const item of pending) item.contextAfter.push(preview);
      pending = pending.filter((item) => item.contextAfter.length < contextLines);

      const level = classifyTraceLine(text);
      if ((args.level === undefined || args.level === level)
        && (query === undefined || await containsQuery(text, query, signal))
        && (regex === undefined || await regex(text, signal))) {
        totalMatches++;
        if (matches.length < maxMatches) {
          const result = { ...preview, file: file.relativePath, level, contextBefore: [...recent], contextAfter: [] };
          matches.push(result);
          if (contextLines > 0) pending.push(result);
        }
      }
      if (contextLines > 0) {
        recent.push(preview);
        if (recent.length > contextLines) recent.shift();
      }
    }
  }
  return { matches, totalMatches, filesSearched, truncated: Boolean(listing?.truncated) || totalMatches > matches.length, warnings };
}
