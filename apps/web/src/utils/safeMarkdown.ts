export type InlineToken = { type: 'text' | 'code' | 'strong'; text: string };

export type MarkdownBlock = { source: string } & (
  | { type: 'heading'; level: 1 | 2 | 3; tokens: InlineToken[] }
  | { type: 'paragraph'; tokens: InlineToken[] }
  | { type: 'list'; ordered: boolean; start: number; items: InlineToken[][] }
  | { type: 'code_block'; language: string; code: string }
);

type Line = { text: string; source: string };
const fencePattern = /^[ \t]{0,3}(\x60{3,})([^\x60]*)$/u;
const headingPattern = /^[ \t]{0,3}(#{1,3})[ \t]+(.*)$/u;
const itemPattern = /^[ \t]{0,3}([-+*]|\d{1,9}\.)[ \t]+(.*)$/u;

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  function add(type: InlineToken['type'], value: string) {
    if (value === '') return;
    const previous = tokens.at(-1);
    if (type === 'text' && previous?.type === 'text') previous.text += value;
    else tokens.push({ type, text: value });
  }

  let end = 0;
  // Keep tag-shaped spans and unsupported links literal. Only the two inline styles produce elements.
  for (const match of text.matchAll(/<[^<>\r\n]*>|\[[^[\]\r\n]*\]\([^()\r\n]*\)|\x60([^\x60\r\n]+)\x60|\*\*([^\r\n]+?)\*\*/gu)) {
    add('text', text.slice(end, match.index));
    if (match[1] !== undefined) add('code', match[1]);
    else if (match[2] !== undefined) add('strong', match[2]);
    else add('text', match[0]);
    end = match.index + match[0].length;
  }
  add('text', text.slice(end));
  return tokens;
}

function collect(lines: readonly Line[], start: number, end: number) {
  return lines.slice(start, end).map((line) => line.source).join('');
}

function startsBlock(text: string) {
  return text.trim() === '' || fencePattern.test(text) || headingPattern.test(text) || itemPattern.test(text);
}

export function parseSafeMarkdown(input: string): MarkdownBlock[] {
  const lines = [...input.matchAll(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu)]
    .filter(([source]) => source.length > 0)
    .map(([source]) => ({ source, text: source.replace(/(?:\r\n|[\r\n])$/u, '') }));
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const start = index;
    const line = lines[index];
    if (!line) break;
    const fence = fencePattern.exec(line.text);
    const heading = headingPattern.exec(line.text);
    const item = itemPattern.exec(line.text);

    if (fence?.[1]) {
      const length = fence[1].length;
      const close = new RegExp('^[ \\t]{0,3}\\x60{' + length + ',}[ \\t]*$', 'u');
      index++;
      while (index < lines.length && !close.test(lines[index]?.text ?? '')) index++;
      const code = collect(lines, start + 1, index);
      if (index < lines.length) index++;
      blocks.push({ type: 'code_block', language: fence[2]?.trim() ?? '', code, source: collect(lines, start, index) });
    } else if (heading?.[1]) {
      const level = heading[1] === '#' ? 1 : heading[1] === '##' ? 2 : 3;
      blocks.push({ type: 'heading', level, tokens: parseInline(heading[2] ?? ''), source: line.source });
      index++;
    } else if (item?.[1]) {
      const ordered = item[1].endsWith('.');
      const items: InlineToken[][] = [];
      for (let match: RegExpExecArray | null = item; match?.[1] && match[1].endsWith('.') === ordered;
        match = itemPattern.exec(lines[index]?.text ?? '')) {
        items.push(parseInline(match[2] ?? ''));
        index++;
      }
      blocks.push({
        type: 'list', ordered, start: ordered ? Number.parseInt(item[1], 10) : 1, items,
        source: collect(lines, start, index),
      });
    } else {
      index++;
      if (line.text.trim() !== '') {
        while (index < lines.length && !startsBlock(lines[index]?.text ?? '')) index++;
      }
      const source = collect(lines, start, index);
      blocks.push({ type: 'paragraph', source, tokens: parseInline(source.replace(/(?:\r\n|[\r\n])$/u, '')) });
    }
  }
  return blocks;
}
