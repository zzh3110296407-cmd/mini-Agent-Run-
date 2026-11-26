import type { InvestigationConclusion, LogLine } from '@mini-agent-run/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extractStructuredErrorSummary, resolveErrorLineSummary } from '../src/utils/errorSummary';
import { splitHighlightSegments } from '../src/utils/highlightSegments';
import { formatLogLineForDisplay } from '../src/utils/logFormat';

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

  it('U2-06 自动美化 JSON 对象和数组，保留普通文本和已换行的 JSON 片段', () => {
    for (const value of [{ result: html }, [1, { result: html }], {}, []]) {
      expect(formatLogLineForDisplay(' \t' + JSON.stringify(value) + ' ')).toEqual({
        displayText: JSON.stringify(value, null, 2), isJson: true,
      });
    }
    for (const text of ['{', '  "result": ' + JSON.stringify(html), '}', '  普通日志\t', 'false', '"scalar"', '', html]) {
      expect(formatLogLineForDisplay(text)).toEqual({ displayText: text, isJson: false });
    }
  });

  it('U2-08 按优先级提取结构化错误或剥离普通日志前缀', () => {
    const fields = { errorMessage: ' primary ', error: { message: 'nested' }, message: 'message', reason: 'reason' };
    expect(extractStructuredErrorSummary(JSON.stringify({ ...fields, toolName: 'lookup', tool: 'other' }))).toBe('lookup · primary');
    expect(extractStructuredErrorSummary(JSON.stringify({ ...fields, errorMessage: ' ', tool: 'read_file_slice' })))
      .toBe('read_file_slice · nested');
    expect(extractStructuredErrorSummary(JSON.stringify({ ...fields, errorMessage: null, error: html }))).toBe(html);
    expect(extractStructuredErrorSummary(JSON.stringify({ error: {}, message: 'message', reason: 'reason' }))).toBe('message');
    expect(extractStructuredErrorSummary(JSON.stringify({ message: '', reason: 'reason' }))).toBe('reason');
    expect(extractStructuredErrorSummary(JSON.stringify({ type: 'tool_call', toolName: 'lookup', step: 0 })))
      .toBe('lookup · tool_call · Step #0');
    expect(extractStructuredErrorSummary('2026-11-26T08:30:45.003+08:00 ERROR: ' + html + ' ')).toBe(html);
    expect(extractStructuredErrorSummary('[2026-11-26 00:30:45Z] [FATAL] Failure')).toBe('Failure');
    expect(extractStructuredErrorSummary('ERROR')).toBe('日志未提供具体错误信息');
  });

  it('U2-08 同来源同行优先取最新逐行摘要，其次取覆盖该行的证据标签', () => {
    const row: LogLine = { lineNumber: 6, level: 'error', text: '{"error":"fallback"}' };
    const old: InvestigationConclusion = {
      summary: 'Findings', recommendations: [],
      errorSummaries: [{ file: 'trace.JSONL', line: 6, summary: 'older' }],
      evidence: [{ kind: 'file_line', file: 'trace.jsonl', startLine: 5, endLine: 7, label: 'older evidence' }],
    };
    const recent: InvestigationConclusion = {
      ...old, errorSummaries: [
        { file: 'wrong.jsonl', line: 6, summary: 'wrong file' },
        { file: 'trace.jsonl', line: 7, summary: 'wrong line' },
        { artifactId: 'art_first', line: 6, summary: 'artifact' },
        { file: './trace.jsonl', line: 6, summary: 'newest' },
        { line: 8, summary: 'implicit single file' },
      ],
      evidence: [{ kind: 'file_line', file: 'C:\\Logs\\trace.jsonl', startLine: 5, endLine: 7, label: 'new evidence' }],
    };
    const context = { filePath: 'C:\\Logs\\trace.jsonl', sourceMode: 'file' as const, artifactId: null, conclusions: [old, recent] };
    expect(resolveErrorLineSummary(row, context)).toEqual({ text: 'newest', source: 'ai' });
    expect(resolveErrorLineSummary(row, { ...context, conclusions: [old, { ...recent, errorSummaries: [] }] }))
      .toEqual({ text: 'older', source: 'ai' });
    expect(resolveErrorLineSummary({ ...row, lineNumber: 5 }, context)).toEqual({ text: 'new evidence', source: 'ai' });
    expect(resolveErrorLineSummary({ ...row, lineNumber: 8 }, { ...context, singleFile: true }))
      .toEqual({ text: 'implicit single file', source: 'ai' });
    expect(resolveErrorLineSummary({ ...row, lineNumber: 8 }, context)).toEqual({ text: 'fallback', source: 'extracted' });
    expect(resolveErrorLineSummary(row, { ...context, sourceMode: 'artifact', artifactId: 'art_first' }))
      .toEqual({ text: 'artifact', source: 'ai' });
    expect(resolveErrorLineSummary(row, { ...context, sourceMode: 'artifact', artifactId: 'art_second' }))
      .toEqual({ text: 'fallback', source: 'extracted' });
  });

  it('U2-08 任意恶意或畸形行都能提取非空摘要', () => {
    const logText = fc.oneof(fc.string(), fc.array(fc.constantFrom('{', '[', '"', html, ...chunks)).map((parts) => parts.join('')));
    fc.assert(fc.property(logText, (raw) => {
      expect(extractStructuredErrorSummary(raw).trim()).not.toBe('');
      expect(extractStructuredErrorSummary(JSON.stringify({ error: raw })).trim()).not.toBe('');
    }), { seed: 5208, numRuns: 100 });
  });
});
