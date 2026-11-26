const forbiddenKeys = new Set(['annotation', 'critical_error_step', 'critical_error_type', 'ground_truth']);
const trajectoryKeys = ['messages', 'steps', 'turns', 'trajectory', 'events', 'history'] as const;
const containerKeys = ['simulations', 'runs', 'trials', 'episodes', 'sessions', 'traces'] as const;
const failure = {
  ok: false, code: 'UNSANITIZABLE_TRACE_JSON', message: 'Structured trace content could not be sanitized.',
} as const;

export interface RecordLocation {
  start: number;
  end: number;
  line?: number;
}

export type JsonPath = readonly (string | number)[];

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findTrajectory(object: Record<string, unknown> | undefined, path: JsonPath = []) {
  for (const key of trajectoryKeys) {
    const values = object?.[key];
    if (Array.isArray(values)) return { values: values as unknown[], path: [...path, key] };
  }
}

export function locateTraceStructure(value: unknown) {
  const root = asObject(value);
  const top = findTrajectory(root);
  let primaryRun: Record<string, unknown> | undefined;
  for (const key of containerKeys) {
    const container = root?.[key];
    const run = Array.isArray(container) ? asObject(container[0]) : undefined;
    if (!run) continue;
    primaryRun ??= run;
    const nested = findTrajectory(run, [key, 0]);
    if (nested) return { trajectory: top ?? nested, primaryRun: run };
  }
  return { trajectory: top, primaryRun };
}

interface Sanitized {
  ok: true;
  sanitized: string;
  stripped: boolean;
  parsedJson?: unknown;
  parsedLines?: unknown[];
  locations?: {
    document?: RecordLocation;
    records?: RecordLocation[];
    messages?: RecordLocation[];
    steps?: RecordLocation[];
    trajectory?: RecordLocation[];
  };
}

function scrubDocument(source: string, evidencePath?: JsonPath) {
  const parsed: unknown = JSON.parse(source);
  const trajectoryPath = evidencePath === undefined ? locateTraceStructure(parsed).trajectory?.path : undefined;
  const masks: RecordLocation[] = [];
  const locations: NonNullable<Sanitized['locations']> = {};
  let position = 0;
  let evidenceOffset: number | undefined;

  function skipSpace() {
    while (position < source.length && ' \t\r\n'.includes(source.charAt(position))) position++;
  }

  function skipString() {
    position++;
    while (position < source.length) {
      const character = source.charAt(position++);
      if (character === '"') return;
      if (character === '\\') position++;
    }
  }

  function scanValue(visible: boolean, records?: RecordLocation[], root = false, depth = -1, trajectoryDepth = -1) {
    skipSpace();
    const start = position;
    if (visible && depth === evidencePath?.length) evidenceOffset = start;
    const character = source.charAt(position);
    if (character === '{') {
      position++;
      skipSpace();
      let previousComma: number | undefined;
      let removalStart: number | undefined;
      let retainedComma: number | undefined;
      while (source.charAt(position) !== '}') {
        const keyStart = position;
        skipString();
        const key: string = JSON.parse(source.slice(keyStart, position));
        skipSpace();
        position++;
        skipSpace();
        const remove = visible && forbiddenKeys.has(key);
        if (remove && removalStart === undefined) {
          removalStart = previousComma ?? keyStart;
          retainedComma = previousComma;
        } else if (!remove && removalStart !== undefined) {
          masks.push({ start: retainedComma === undefined ? removalStart : retainedComma + 1, end: keyStart });
          removalStart = undefined;
        }

        let childRecords: RecordLocation[] | undefined;
        if (root && (key === 'messages' || key === 'steps')) {
          childRecords = source.charAt(position) === '[' ? [] : undefined;
          locations[key] = childRecords;
        }
        const childTrajectoryDepth = trajectoryPath?.[trajectoryDepth] === key ? trajectoryDepth + 1 : -1;
        if (childTrajectoryDepth === trajectoryPath?.length) {
          childRecords ??= [];
          locations.trajectory = childRecords;
        }
        const childDepth = evidencePath?.[depth] === key ? depth + 1 : -1;
        // A later member replaces the previous subtree at the same decoded key.
        if (childDepth !== -1) evidenceOffset = undefined;
        scanValue(visible && !remove, childRecords, false, childDepth, childTrajectoryDepth);
        skipSpace();
        if (source.charAt(position) === ',') {
          previousComma = position++;
          skipSpace();
        }
      }
      if (removalStart !== undefined) masks.push({ start: removalStart, end: position });
      position++;
    } else if (character === '[') {
      position++;
      skipSpace();
      for (let index = 0; source.charAt(position) !== ']'; index++) {
        const itemStart = position;
        const childDepth = evidencePath?.[depth] === index ? depth + 1 : -1;
        const childTrajectoryDepth = trajectoryPath?.[trajectoryDepth] === index ? trajectoryDepth + 1 : -1;
        scanValue(visible, undefined, false, childDepth, childTrajectoryDepth);
        records?.push({ start: itemStart, end: position });
        skipSpace();
        if (source.charAt(position) === ',') {
          position++;
          skipSpace();
        }
      }
      position++;
    } else if (character === '"') {
      skipString();
    } else {
      while (position < source.length && !' \t\r\n,]}'.includes(source.charAt(position))) position++;
    }
    if (root) locations.document = { start, end: position };
  }

  // Scan source keys individually because JSON.parse collapses duplicate members.
  if (Array.isArray(parsed)) locations.records = [];
  scanValue(true, locations.records, true, evidencePath ? 0 : -1, trajectoryPath ? 0 : -1);
  if (masks.length === 0) return { parsed, text: source, stripped: false, locations, evidenceOffset };
  const chunks: string[] = [];
  let previous = 0;
  for (const { start, end } of masks.sort((a, b) => a.start - b.start)) {
    chunks.push(source.slice(previous, start), source.slice(start, end).replace(/[^\r\n]/g, ' '));
    previous = end;
  }
  const text = chunks.join('') + source.slice(previous);
  return { parsed: JSON.parse(text) as unknown, text, stripped: true, locations, evidenceOffset };
}

export function traceValueOffset(sanitizedRecord: string, path: JsonPath) {
  return scrubDocument(sanitizedRecord, path).evidenceOffset;
}

export function* traceLines(content: string) {
  let line = 1;
  for (let start = 0; start < content.length; line++) {
    const newline = content.indexOf('\n', start);
    const end = newline === -1 ? content.length : newline;
    const stop = newline !== -1 && content.charAt(end - 1) === '\r' ? end - 1 : end;
    const next = newline === -1 ? content.length : newline + 1;
    yield { line, start, end: stop, text: content.slice(start, stop) };
    start = next;
  }
}

function looksStructured(text: string) {
  return /^\s*(?:\{\s*(?:"|\}|$)|\[\s*(?:["{[\]]|$))/.test(text);
}

function mightBeJson(text: string) {
  return /^\s*(?:\[|\{)/.test(text);
}

function scrubLines(content: string, strict: boolean): Sanitized {
  const parsedLines: unknown[] = [];
  const records: RecordLocation[] = [];
  const chunks: string[] = [];
  let previous = 0;
  let delta = 0;
  let structuredOnly = true;
  for (const { line, start, end, text } of traceLines(content)) {
    if (!text.trim()) continue;
    if (!strict && !mightBeJson(text)) {
      structuredOnly = false;
      continue;
    }
    let row;
    try {
      row = scrubDocument(text);
    } catch (error) {
      if (strict || looksStructured(text) || !(error instanceof SyntaxError)) throw error;
      // Bracketed timestamps and severity tags are ordinary log text.
      structuredOnly = false;
      continue;
    }
    const cleaned = row.stripped ? JSON.stringify(row.parsed) : text;
    records.push({ line, start: start + delta, end: start + delta + cleaned.length });
    parsedLines.push(row.parsed);
    if (row.stripped) {
      chunks.push(content.slice(previous, start), cleaned);
      previous = end;
      delta += cleaned.length - (end - start);
    }
  }
  return {
    ok: true, sanitized: chunks.length ? chunks.join('') + content.slice(previous) : content, stripped: chunks.length > 0,
    ...(strict || (structuredOnly && parsedLines.length > 0) ? { parsedLines, locations: { records } } : {}),
  };
}

export function sanitizeTraceContent(content: string, relativePath: string): Sanitized | typeof failure {
  const lower = relativePath.toLowerCase();
  try {
    if (lower.endsWith('.jsonl')) return scrubLines(content, true);
    if (lower.endsWith('.json')) {
      const { parsed, text, stripped, locations } = scrubDocument(content);
      return { ok: true, parsedJson: parsed, sanitized: text, stripped, locations };
    }
    if (mightBeJson(content)) {
      try {
        const { parsed, text, stripped, locations } = scrubDocument(content);
        return { ok: true, parsedJson: parsed, sanitized: text, stripped, locations };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return scrubLines(content, false);
  } catch {
    return failure;
  }
}
