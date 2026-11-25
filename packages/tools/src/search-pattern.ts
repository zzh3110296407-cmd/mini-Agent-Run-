import { setImmediate } from 'node:timers/promises';
import { checkAbort, ToolError } from './tool-error.js';

const blockSize = 64 * 1024;
type Matcher = (line: string, signal: AbortSignal) => Promise<boolean>;

function invalidRegex(): never {
  throw new ToolError('INVALID_REGEX', 'The regular expression is invalid or uses unsupported syntax.');
}

interface FixedPattern {
  expression: RegExp;
  width: number;
}

function fixedPattern(source: string): FixedPattern {
  return { expression: new RegExp(source, 'i'), width: source.length };
}

async function matchFixed(pattern: FixedPattern, line: string, signal: AbortSignal, from: number, start = false, end = false) {
  if (from > line.length || (start && from !== 0)) return;
  const { expression, width } = pattern;
  if (start || end) {
    const offset = start ? 0 : Math.max(from, line.length - width);
    const part = start && !end ? line.slice(0, width) : line.slice(offset);
    if (start && end && part.length > width) return;
    const anchored = new RegExp((start ? '^' : '') + '(?:' + expression.source + ')' + (end ? '$' : ''), 'i');
    const match = anchored.exec(part);
    return match ? offset + match.index + match[0].length : undefined;
  }
  for (let offset = from; offset < line.length || offset === from; offset += blockSize) {
    if (offset !== from) {
      await setImmediate();
      checkAbort(signal);
    }
    const match = expression.exec(line.slice(offset, offset + blockSize + width));
    if (match) return offset + match.index + match[0].length;
  }
}

function compileBranch(branch: string): Matcher {
  const start = branch.startsWith('^');
  let source = start ? branch.slice(1) : branch;
  let end = false;
  let wildcard: number | undefined;
  let bracket = false;
  for (let index = 0; index < source.length; index++) {
    const character = source.charAt(index);
    if (character === '\\') {
      const escape = source.charAt(++index);
      if (!escape || /[0-9kBb]/.test(escape)) invalidRegex();
      continue;
    }
    if (character === '[' && !bracket) bracket = true;
    else if (character === ']' && bracket) bracket = false;
    else if (!bracket) {
      if (character === '$' && index === source.length - 1) end = true;
      else if (character === '.' && /[*+]/.test(source.charAt(index + 1))) {
        if (wildcard !== undefined) invalidRegex();
        wildcard = index++;
      } else if ('(){}*+?^$'.includes(character)) invalidRegex();
    }
  }
  if (bracket) invalidRegex();
  if (end) source = source.slice(0, -1);
  if (wildcard === undefined) {
    const pattern = fixedPattern(source);
    return async (line, signal) => (await matchFixed(pattern, line, signal, 0, start, end)) !== undefined;
  }
  const before = fixedPattern(source.slice(0, wildcard));
  const after = fixedPattern(source.slice(wildcard + 2));
  const minLength = source.charAt(wildcard + 1) === '+' ? 1 : 0;
  return async (line, signal) => {
    const leftEnd = await matchFixed(before, line, signal, 0, start);
    return leftEnd !== undefined && (await matchFixed(after, line, signal, leftEnd + minLength, false, end)) !== undefined;
  };
}

export function compileSearchPattern(source: string): Matcher {
  if (source.length === 0 || source.length > 200) invalidRegex();
  try {
    // Validate escapes and character classes with the engine before splitting alternatives.
    new RegExp(source);
    const branches: string[] = [];
    let start = 0;
    let bracket = false;
    for (let index = 0; index < source.length; index++) {
      const character = source.charAt(index);
      if (character === '\\') index++;
      else if (character === '[' && !bracket) bracket = true;
      else if (character === ']' && bracket) bracket = false;
      else if (character === '|' && !bracket) {
        branches.push(source.slice(start, index));
        start = index + 1;
      }
    }
    branches.push(source.slice(start));
    if (branches.some((branch) => branch === '')) invalidRegex();
    const matchers = branches.map(compileBranch);
    return async (line, signal) => {
      for (const matches of matchers) if (await matches(line, signal)) return true;
      return false;
    };
  } catch {
    return invalidRegex();
  }
}

export async function containsQuery(line: string, query: string, signal: AbortSignal) {
  for (let start = 0; start < line.length; start += blockSize) {
    if (start > 0) {
      await setImmediate();
      checkAbort(signal);
    }
    if (line.slice(start, start + blockSize + query.length).toLowerCase().includes(query)) return true;
  }
  return false;
}
