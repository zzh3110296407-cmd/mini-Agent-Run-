import {
  TextSliceResponseSchema, type LogLevel, type LogLine, type TextSliceResponse,
} from '@mini-agent-run/shared';

export function classifyLogLevel(text: string): LogLevel {
  if (/\b(?:ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/i.test(text) || /"isError"\s*:\s*true\b/.test(text)) {
    return 'error';
  }
  if (/\b(?:WARN|WARNING)\b/i.test(text)) return 'warn';
  if (/\b(?:INFO|DEBUG|TRACE)\b/i.test(text)) return 'info';
  return 'other';
}

export function sliceTextContent(
  content: string, { offsetLine, limit, level, q }: { offsetLine: number; limit: number; level?: LogLevel; q?: string },
  classify: (text: string) => LogLevel = classifyLogLevel,
): TextSliceResponse {
  const keyword = q?.toLowerCase() ?? '';
  const lines: LogLine[] = [];
  let totalLines = 0;
  let matchedLines = 0;
  let nextOffsetLine: number | null = null;

  for (let start = 0; start < content.length;) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const text = content.slice(start, newline !== -1 && content[end - 1] === '\r' ? end - 1 : end);
    start = newline === -1 ? content.length : newline + 1;
    totalLines += 1;
    const lineLevel = classify(text);
    if ((level !== undefined && lineLevel !== level) || (keyword && !text.toLowerCase().includes(keyword))) continue;

    matchedLines += 1;
    if (totalLines < offsetLine) continue;
    if (lines.length < limit) lines.push({ lineNumber: totalLines, level: lineLevel, text });
    else nextOffsetLine ??= totalLines;
  }

  return TextSliceResponseSchema.parse({
    totalLines, matchedLines, offsetLine, limit, hasMore: nextOffsetLine !== null, nextOffsetLine, lines,
  });
}
