export type HighlightSegment = { text: string; matched: boolean };

function isCharacterBoundary(text: string, offset: number) {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function splitHighlightSegments(text: string, query: string): HighlightSegment[] {
  const needle = query.trim().toLowerCase();
  if (text === '') return [];
  if (needle === '') return [{ text, matched: false }];

  // Sigma can lowercase differently in the full line and in the matched substring.
  const folded = text.toLowerCase().replaceAll('ς', 'σ');
  const search = needle.replaceAll('ς', 'σ');
  const boundaries = new Map<number, number>();
  if (folded.length !== text.length) {
    let lowered = 0;
    let original = 0;
    boundaries.set(0, 0);
    for (const character of text) {
      lowered += character.toLowerCase().length;
      original += character.length;
      boundaries.set(lowered, original);
    }
  }

  const segments: HighlightSegment[] = [];
  let previous = 0;
  for (let found = folded.indexOf(search); found !== -1;) {
    const after = found + search.length;
    const start = boundaries.size ? boundaries.get(found) : found;
    const end = boundaries.size ? boundaries.get(after) : after;
    if (start !== undefined && end !== undefined && isCharacterBoundary(text, start) && isCharacterBoundary(text, end)) {
      const candidate = text.slice(start, end);
      if (candidate.toLowerCase() === needle) {
        if (start > previous) segments.push({ text: text.slice(previous, start), matched: false });
        segments.push({ text: candidate, matched: true });
        previous = end;
        found = folded.indexOf(search, after);
        continue;
      }
    }
    found = folded.indexOf(search, found + 1);
  }
  if (previous < text.length) segments.push({ text: text.slice(previous), matched: false });
  return segments;
}
