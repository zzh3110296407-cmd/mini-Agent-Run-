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
