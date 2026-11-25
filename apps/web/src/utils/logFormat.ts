import type { LogLine } from '@mini-agent-run/shared';

function prettyJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

export function formatSliceAsJson(lines: readonly LogLine[]): { text: string; formattedCount: number; plainCount: number } {
  const whole = prettyJson(lines.map(({ text }) => text).join('\n'));
  if (whole !== undefined) return { text: whole, formattedCount: 1, plainCount: 0 };

  let formattedCount = 0;
  const text = lines.map((line) => {
    const formatted = prettyJson(line.text);
    if (formatted === undefined) return line.text;
    formattedCount++;
    return '// 原始行 ' + line.lineNumber + '\n' + formatted;
  }).join('\n');
  return { text, formattedCount, plainCount: lines.length - formattedCount };
}
