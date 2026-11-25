import type { AgentTool, SaveArtifactInput, ToolExecutionContext } from '@mini-agent-run/agent';
import { ArtifactMetaSchema, MAX_INLINE_TOOL_OUTPUT_BYTES, ToolOutputSummarySchema, type ArtifactMeta } from '@mini-agent-run/shared';
import {
  formatOffloadedToolResultContent, offloadOversizedToolOutput, summarizeToolOutput,
  truncateUtf8TailSafe, wrapToolsWithArtifactOffload,
} from '@mini-agent-run/tools';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

const metadata = {
  runId: 'run_demo', sessionId: 'ses_demo', toolCallId: 'tc_demo', sourceTool: 'search_logs', title: 'Search results',
};
const cap = MAX_INLINE_TOOL_OUTPUT_BYTES;
const longOutput = JSON.stringify({ matches: ['中🙂'.repeat(900)] });
const loneSurrogate = /[\uD800-\uDFFF]/u;

function artifact(content: string, extra: Partial<ArtifactMeta> = {}): ArtifactMeta {
  const summary = summarizeToolOutput(content);
  return ArtifactMetaSchema.parse({
    ...metadata, id: 'art_9542f584-c143-4c95-88af-e94c681c4999', contentType: 'application/json',
    createdAt: '2026-11-25T00:00:00.000Z', byteSize: summary.byteSize, lineCount: summary.lineCount, summary, ...extra,
  });
}

function fixture(existing: ArtifactMeta | null = null) {
  const store = {
    save: vi.fn(({ content, summary, ...input }: SaveArtifactInput) => artifact(content, { ...input, summary })),
    getMeta: vi.fn(() => existing),
    readSlice: vi.fn(() => null),
  };
  const ctx: ToolExecutionContext = {
    ...metadata, targetPath: '/demo', allowedRoots: ['/demo'], toolMode: 'mock',
    artifactStore: store, signal: new AbortController().signal,
  };
  return { store, ctx };
}

describe('[F04_LARGE_ARTIFACT_STORE] inline output budget and complete Artifact contents', () => {
  it.each([
    ['', 0, { error: 0, warn: 0, info: 0, other: 0 }, null],
    ['plain', 1, { error: 0, warn: 0, info: 0, other: 1 }, null],
    ['INFO start\r\n{"status":"failed"}\nWARN retry\r\n\nERROR again\n',
      5, { error: 2, warn: 1, info: 1, other: 1 }, 2],
  ] as const)('summarizes physical lines and classifies structured errors (%j)', (raw, lineCount, levelCounts, firstErrorLine) => {
    expect(ToolOutputSummarySchema.parse(summarizeToolOutput(raw))).toMatchObject({
      byteSize: Buffer.byteLength(raw), lineCount, levelCounts, firstErrorLine, previewHead: raw, truncatedForLlm: false,
    });
  });

  it('truncates the tail on code point boundaries and replaces isolated surrogates', () => {
    expect(truncateUtf8TailSafe('a\uD800中🙂\uDC00', 7)).toEqual({ text: '🙂�', truncated: true });
    expect(truncateUtf8TailSafe('a\uD800中🙂\uDC00', 14)).toEqual({ text: 'a�中🙂�', truncated: false });
    expect(truncateUtf8TailSafe('🙂', 3)).toEqual({ text: '', truncated: true });
    expect(summarizeToolOutput('abcd', { maxInlineBytes: 1, previewHeadBytes: 2, previewTailBytes: 2 }))
      .toMatchObject({ previewHead: 'ab', previewTail: 'cd', truncatedForLlm: true });
  });

  it('returns the same inline object at 6,144 UTF-8 bytes without looking up its pointer', async () => {
    const { store } = fixture();
    const result = { content: '中'.repeat(cap / 3), isError: false, artifactId: 'art_missing' };
    expect(await offloadOversizedToolOutput(result, metadata, store)).toBe(result);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.getMeta).not.toHaveBeenCalled();
  });

  it.each([
    ['application/json', longOutput],
    ['application/x-ndjson', '{"status":"failed"}\n\n'.repeat(400)],
    ['text/plain', 'ERROR lookup failed\n'.repeat(400)],
  ] as const)('stores the exact oversized body and infers %s', async (contentType, content) => {
    const { store } = fixture();
    const output = await offloadOversizedToolOutput({ content, isError: true }, metadata, store);
    expect(store.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content, contentType, ...metadata }));
    expect(output).toMatchObject({ isError: true, summary: { truncatedForLlm: true } });
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(cap);
    expect(output.content).not.toContain(content);
    expect(JSON.parse(output.content)).toMatchObject({
      artifactId: output.artifactId, truncatedForLlm: true, byteSize: Buffer.byteLength(content),
      readHint: expect.stringContaining('read_artifact_slice'),
    });
  });

  it('reuses a valid same-session pointer and still replaces an oversized body', async () => {
    const existing = artifact(longOutput);
    const { store } = fixture(existing);
    const output = await offloadOversizedToolOutput(
      { content: longOutput, isError: true, artifactId: existing.id }, metadata, store, { maxInlineBytes: 512 },
    );
    expect(store.save).not.toHaveBeenCalled();
    expect(store.getMeta).toHaveBeenCalledExactlyOnceWith(existing.id);
    expect(output).toMatchObject({ isError: true, artifactId: existing.id, summary: { truncatedForLlm: true } });
    expect(Buffer.byteLength(output.content)).toBeLessThanOrEqual(512);
    expect(JSON.parse(output.content).artifactId).toBe(existing.id);
  });

  it.each([null, 'ses_other'])('saves under the current session for missing or foreign metadata (%s)', async (owner) => {
    const oldId = 'art_previous';
    const { store } = fixture(owner ? artifact(longOutput, { id: oldId, sessionId: owner }) : null);
    const output = await offloadOversizedToolOutput({ content: longOutput, isError: false, artifactId: oldId }, metadata, store);
    expect(store.getMeta).toHaveBeenCalledExactlyOnceWith(oldId);
    expect(store.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: metadata.sessionId, content: longOutput }));
    expect(output.artifactId).not.toBe(oldId);
    expect(JSON.parse(output.content).artifactId).toBe(output.artifactId);
  });

  it.each([6145, 8192, 255, 512.5, NaN])('rejects invalid inline configuration (%s) at each output entry', async (maxInlineBytes) => {
    const { store } = fixture();
    const options = { maxInlineBytes };
    expect(() => formatOffloadedToolResultContent(artifact(longOutput), longOutput, options)).toThrow(RangeError);
    expect(() => wrapToolsWithArtifactOffload([], options)).toThrow(RangeError);
    await expect(offloadOversizedToolOutput({ content: '', isError: false }, metadata, store, options)).rejects.toThrow(RangeError);
    expect(store.save).not.toHaveBeenCalled();
    if (maxInlineBytes !== 255) expect(() => summarizeToolOutput('', options)).toThrow(RangeError);
  });

  it('wraps calls, preserves their schema and uses the real call ID or creates a valid fallback ID', async () => {
    const { store, ctx } = fixture();
    const content = '中'.repeat(250);
    const tool: AgentTool = {
      name: 'demo', description: 'Demo tool', parameters: { type: 'object' },
      execute: vi.fn(async () => ({ content, isError: true })),
    };
    const readTool: AgentTool = { ...tool, name: 'read_artifact_slice' };
    const [wrapped, read] = wrapToolsWithArtifactOffload([tool, readTool], { maxInlineBytes: 512 });
    expect(wrapped?.parameters).toBe(tool.parameters);
    expect(wrapped).toMatchObject({ name: tool.name, description: tool.description });
    expect(read).toBe(readTool);
    expect(await read?.execute({}, ctx)).toEqual({ content, isError: true });
    expect(store.save).not.toHaveBeenCalled();

    const first = await wrapped?.execute({}, ctx);
    expect(first).toMatchObject({ isError: true, artifactId: expect.any(String) });
    expect(Buffer.byteLength(first?.content ?? '')).toBeLessThanOrEqual(512);
    await wrapped?.execute({}, { ...ctx, toolCallId: 'invalid' });
    expect(store.save.mock.calls.map(([input]) => input.toolCallId)).toEqual([
      ctx.toolCallId, expect.stringMatching(/^tc_[0-9a-f-]{36}$/),
    ]);
  });

  it('fits escaped metadata and previews at the 256-byte floor and preserves the first error when there is room', () => {
    const raw = 'INFO start\nERROR ' + '\u0000"\\🙂'.repeat(1500);
    const saved = artifact(raw, { sourceTool: '"'.repeat(128), title: '\u0000'.repeat(256) });
    const minimal = formatOffloadedToolResultContent(saved, raw, { maxInlineBytes: 256 });
    expect(Buffer.byteLength(minimal)).toBeLessThanOrEqual(256);
    expect(JSON.parse(minimal)).toMatchObject({
      artifactId: saved.id, byteSize: saved.byteSize, lineCount: 2, levelCounts: saved.summary.levelCounts,
      truncatedForLlm: true, firstErrorLine: 2,
    });
    const useful = JSON.parse(formatOffloadedToolResultContent(saved, raw));
    expect(useful.firstErrorExcerpt).toMatch(/^ERROR /);
  });

  it('keeps the actual suffix as the tail preview is shortened', () => {
    const raw = 'HEAD' + '🙂'.repeat(600) + 'TAIL';
    const saved = artifact(raw);
    const full = formatOffloadedToolResultContent(saved, raw);
    const maxInlineBytes = Buffer.byteLength(full) - 100;
    const compact = formatOffloadedToolResultContent(saved, raw, { maxInlineBytes });
    expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(maxInlineBytes);
    expect(JSON.parse(compact).previewTail).toMatch(/TAIL$/);
    expect(JSON.parse(compact).previewHead).toBe(JSON.parse(full).previewHead);
  });

  it('rejects an external store ID that cannot fit even with zero optional summary fields', () => {
    const saved = artifact(longOutput, { id: 'art_' + 'a'.repeat(cap) });
    expect(() => formatOffloadedToolResultContent(saved, longOutput)).toThrow(RangeError);
  });

  it('keeps tail and JSON within the byte budget across 120 seeded Unicode cases', () => {
    const chunk = fc.array(fc.constantFrom('a', '中', '🙂', '\u{20BB7}', '\uD800', '\uDC00', '\u0000', '"', '\\'), {
      minLength: 4, maxLength: 34,
    }).map((characters) => characters.join(''));
    fc.assert(fc.property(chunk, fc.integer({ min: 512, max: cap }), fc.integer({ min: 900, max: 1300 }),
      (value, maxInlineBytes, copies) => {
        const raw = 'ERROR ' + value.repeat(copies);
        const tail = truncateUtf8TailSafe(raw, maxInlineBytes);
        expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(maxInlineBytes);
        expect(tail.text).not.toMatch(loneSurrogate);
        const saved = artifact(raw, { title: value.repeat(20), sourceTool: value });
        const content = formatOffloadedToolResultContent(saved, raw, { maxInlineBytes });
        expect(Buffer.byteLength(content)).toBeLessThanOrEqual(maxInlineBytes);
        const decoded = JSON.parse(content);
        expect(decoded.artifactId).toBe(saved.id);
        for (const field of Object.values(decoded)) {
          if (typeof field === 'string') expect(field).not.toMatch(loneSurrogate);
        }
      }), { seed: 104271, numRuns: 120 });
  });
});
