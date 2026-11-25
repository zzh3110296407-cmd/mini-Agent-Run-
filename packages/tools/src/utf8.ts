export function truncateUtf8Safe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid UTF-8 byte limit.');
  let bytes = 0;
  let result = '';
  for (const character of text) {
    const safeCharacter = /[\uD800-\uDFFF]/u.test(character) ? '\uFFFD' : character;
    bytes += Buffer.byteLength(safeCharacter, 'utf8');
    if (bytes > maxBytes) return { text: result, truncated: true };
    result += safeCharacter;
  }
  return { text: result, truncated: false };
}

export function truncateUtf8TailSafe(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid UTF-8 byte limit.');
  const points: string[] = [];
  let bytes = 0;
  let end = text.length;
  while (end > 0) {
    let start = end - 1;
    const last = text.charCodeAt(start);
    const previous = text.charCodeAt(start - 1);
    if (last >= 0xDC00 && last <= 0xDFFF && previous >= 0xD800 && previous <= 0xDBFF) start--;
    const point = text.slice(start, end);
    const safe = /[\uD800-\uDFFF]/u.test(point) ? '\uFFFD' : point;
    bytes += Buffer.byteLength(safe);
    if (bytes > maxBytes) break;
    points.push(safe);
    end = start;
  }
  return { text: points.reverse().join(''), truncated: end > 0 };
}
