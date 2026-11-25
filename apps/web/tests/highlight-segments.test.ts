import type { LogLine } from '@mini-agent-run/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitHighlightSegments } from '../src/utils/highlightSegments';
import { formatSliceAsJson } from '../src/utils/logFormat';

const html = '<script>alert(1)</script><img src=x onerror=alert(1)>';
const chunks = ['a', 'A', 'B', 'aAa', '中', '🙂', '𐐀', '𐐨', 'İ', 'i\u0307', 'Σ', 'ς', 'ΟΣ', 'σ', '\ud800', html, '[.*+?^$()]', ' ', '\t'] as const;

describe('F11_LARGE_LOG_INSPECTOR_UI · W3-01', () => {
  it('保留 120 组原始码元，并与逐个候选原文子串的匹配结果一致', () => {
    const piece = fc.constantFrom(...chunks);
    const text = fc.array(piece, { maxLength: 18 }).map((values) => values.join(''));
    const query = fc.oneof(fc.constantFrom('', '  ', 'aAa', ' [.*+?^$()] ', '<SCRIPT>', 'i', 'i\u0307', 'ΟΣ', '𐐨'),
      fc.array(piece, { maxLength: 4 }).map((values) => values.join('')));
    fc.assert(fc.property(text, query, (input, rawQuery) => {
      const needle = rawQuery.trim().toLowerCase();
      const segments = splitHighlightSegments(input, rawQuery);
      expect(segments.map(({ text }) => text).join('')).toBe(input);
      const codepoints = [...input];
      const expected: number[] = [];
      if (needle) {
        let offset = 0;
        for (let start = 0; start < codepoints.length;) {
          let candidate = '';
          let end = start;
          while (end < codepoints.length && candidate.toLowerCase().length < needle.length) candidate += codepoints[end++];
          if (candidate.toLowerCase() === needle) {
            expected.push(offset);
            start = end;
            offset += candidate.length;
          } else offset += codepoints[start++]!.length;
        }
      }
      let offset = 0;
      const actual: number[] = [];
      for (const segment of segments) {
        expect(segment.text).not.toBe('');
        if (segment.matched) {
          expect(segment.text.toLowerCase()).toBe(needle);
          actual.push(offset);
        }
        offset += segment.text.length;
      }
      expect(actual).toEqual(expected);
    }), { seed: 3301, numRuns: 120 });
  });

  it('保留重叠尾部、字面元字符及扩张小写映射的原文坐标', () => {
    expect(splitHighlightSegments('aAaAa', ' AAa ')).toEqual([
      { text: 'aAa', matched: true }, { text: 'Aa', matched: false },
    ]);
    expect(splitHighlightSegments('İxİi𐐀[.*]', 'i\u0307')).toEqual([
      { text: 'İ', matched: true }, { text: 'x', matched: false }, { text: 'İ', matched: true }, { text: 'i𐐀[.*]', matched: false },
    ]);
    expect(splitHighlightSegments('İi', 'i')).toEqual([{ text: 'İ', matched: false }, { text: 'i', matched: true }]);
    expect(splitHighlightSegments('İ[.*]', '[.*]')).toEqual([{ text: 'İ', matched: false }, { text: '[.*]', matched: true }]);
    expect(splitHighlightSegments('', '  ')).toEqual([]);
    expect(splitHighlightSegments(html, '  ')).toEqual([{ text: html, matched: false }]);
  });

  it('优先美化整段 JSON，再逐行美化 JSONL 并保留普通行和原始行号', () => {
    const line = (lineNumber: number, text: string): LogLine => ({ lineNumber, level: 'other', text });
    const json = JSON.stringify({ result: html });
    expect(formatSliceAsJson([line(5, '{'), line(6, '"result":' + JSON.stringify(html)), line(7, '}')])).toEqual({
      text: JSON.stringify({ result: html }, null, 2), formattedCount: 1, plainCount: 0,
    });
    expect(formatSliceAsJson([line(12, json), line(19, '  普通日志\t'), line(24, 'false'), line(31, '')])).toEqual({
      text: '// L12\n' + JSON.stringify({ result: html }, null, 2) + '\n  普通日志\t\n// L24\nfalse\n',
      formattedCount: 2, plainCount: 2,
    });
    expect(formatSliceAsJson([])).toEqual({ text: '', formattedCount: 0, plainCount: 0 });
  });
});
