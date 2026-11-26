import { MAX_INLINE_TOOL_OUTPUT_BYTES, type LogLine, type TextSliceResponse } from '@mini-agent-run/shared';
import { truncateUtf8Safe } from './utf8.js';

export const inlineBytes = MAX_INLINE_TOOL_OUTPUT_BYTES;
const fitting = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= inlineBytes;

export function inlinePrefix(text: string, fits: (prefix: string) => boolean) {
  const points = Array.from(truncateUtf8Safe(text, inlineBytes).text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(points.slice(0, mid).join(''))) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('');
}

export function boundedLinePage(
  page: TextSliceResponse, requestedOffset: number, limit: number, extra?: { file: string },
) {
  const lines: LogLine[] = [];
  const file = extra ? { file: truncateUtf8Safe(extra.file, 512).text } : {};
  const pack = (selected: LogLine[], next: number | null, lineTruncated = false) => ({
    ...file, ...page, offsetLine: requestedOffset, limit, lines: selected,
    nextOffsetLine: next, hasMore: next !== null,
    ...(lineTruncated ? { lineTruncated: true } : {}),
  });
  const pageNext = page.hasMore && page.nextOffsetLine !== null && page.nextOffsetLine > requestedOffset
    ? page.nextOffsetLine : null;
  for (const [index, line] of page.lines.entries()) {
    const clipped = truncateUtf8Safe(line.text, inlineBytes);
    const safeLine = { ...line, text: clipped.text };
    const next = page.lines[index + 1]?.lineNumber ?? pageNext;
    const candidate = [...lines, safeLine];
    if (lines.length < limit && !clipped.truncated && fitting(pack(candidate, next))) {
      lines.push(safeLine);
      continue;
    }
    if (lines.length > 0) return pack(lines, line.lineNumber > requestedOffset ? line.lineNumber : pageNext);
    const after = next !== null && next > requestedOffset ? next : null;
    const prefix = inlinePrefix(safeLine.text, (text) => fitting(pack([{ ...line, text }], after, true)));
    return pack([{ ...line, text: prefix }], after, true);
  }
  return pack(lines, pageNext);
}

const stepTelemetry = new Set(['raw_data', 'usage', 'token_usage', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'cost']);

export function compactStepRecord(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !stepTelemetry.has(key)));
}

type Step = { step: number; line: number; value: unknown };

export function boundedSteps(file: string, records: readonly Step[]) {
  const steps: Step[] = [];
  const displayFile = truncateUtf8Safe(file, 512).text;
  const pack = (values: Step[], nextStep: number | null, stepTruncated = false) => ({
    file: displayFile, steps: values, hasMore: nextStep !== null, nextStep, ...(stepTruncated ? { stepTruncated: true } : {}),
  });
  for (const [index, entry] of records.entries()) {
    const record = { ...entry, value: compactStepRecord(entry.value) };
    const next = records[index + 1]?.step ?? null;
    const candidate = [...steps, record];
    if (fitting(pack(candidate, next))) {
      steps.push(record);
      continue;
    }
    const previous = steps.at(-1);
    if (previous && record.step > previous.step) return pack(steps, record.step);
    if (previous) return pack(steps, records.slice(index).find((item) => item.step > previous.step)?.step ?? null, true);
    const following = records.slice(index + 1).find((item) => item.step > record.step)?.step ?? null;
    const value = inlinePrefix(JSON.stringify(record.value) ?? '', (prefix) => (
      fitting(pack([{ ...record, value: prefix }], following, true))
    ));
    return pack([{ ...record, value }], following, true);
  }
  return pack(steps, null);
}
