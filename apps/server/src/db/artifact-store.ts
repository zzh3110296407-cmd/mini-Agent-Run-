import type { ArtifactStorePort } from '@mini-agent-run/agent';
import {
  ArtifactIdSchema, ArtifactMetaSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES, type ArtifactMeta,
} from '@mini-agent-run/shared';
import { classifyTraceLine } from '@mini-agent-run/tools';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sliceTextContent } from '../fs/file-slice.js';

type MetadataRow = Omit<ArtifactMeta, 'summary'> & { summaryJson: string };
type ContentRow = { content: string | Buffer };
type SliceQuery = Parameters<typeof sliceTextContent>[1];

const metadataColumns = `id, run_id AS runId, session_id AS sessionId, tool_call_id AS toolCallId,
  source_tool AS sourceTool, title, content_type AS contentType, byte_size AS byteSize,
  line_count AS lineCount, summary_json AS summaryJson, created_at AS createdAt`;

const sliceQuery = z.object({
  offsetLine: z.number().int().positive(),
  limit: z.number().int().min(1).max(MAX_ARTIFACT_SLICE_LINES),
  level: LogLevelSchema.optional(),
  q: z.string().optional(),
});

function parseMetadata({ summaryJson, ...metadata }: MetadataRow) {
  return ArtifactMetaSchema.parse({ ...metadata, summary: JSON.parse(summaryJson) });
}

function sliceArtifact({ content }: ContentRow, query: SliceQuery) {
  return sliceTextContent(typeof content === 'string' ? content : content.toString('utf16le'), query, classifyTraceLine);
}

function countLines(text: string) {
  let count = 0;
  for (let start = 0; start < text.length; count++) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) return count + 1;
    start = newline + 1;
  }
  return count;
}

export function createSqliteArtifactStore(db: Database.Database): ArtifactStorePort {
  const insert = db.prepare(`INSERT INTO artifacts (id, run_id, session_id, tool_call_id, source_tool, title,
    content_type, byte_size, line_count, content, summary_json, created_at)
    VALUES (@id, @runId, @sessionId, @toolCallId, @sourceTool, @title, @contentType,
      @byteSize, @lineCount, @content, @summaryJson, @createdAt)`);
  const getMetadata = db.prepare<[string], MetadataRow>(`SELECT ${metadataColumns} FROM artifacts WHERE id = ?`);
  const getContent = db.prepare<[string], ContentRow>('SELECT content FROM artifacts WHERE id = ?');

  return {
    save(input) {
      const { content: body, ...inputMetadata } = input;
      const raw = z.string().parse(body);
      const artifact = ArtifactMetaSchema.parse({
        ...inputMetadata,
        id: 'art_' + randomUUID(),
        byteSize: Buffer.byteLength(raw),
        lineCount: countLines(raw),
        createdAt: new Date().toISOString(),
      });
      // SQLite TEXT encodes as UTF-8. Keep lone UTF-16 code units lossless with a BLOB in that case.
      const content = /[\uD800-\uDFFF]/u.test(raw) ? Buffer.from(raw, 'utf16le') : raw;
      const { summary, ...metadata } = artifact;
      insert.run({ ...metadata, content, summaryJson: JSON.stringify(summary) });
      return artifact;
    },
    getMeta(artifactId) {
      const id = ArtifactIdSchema.safeParse(artifactId);
      if (!id.success) return null;
      const row = getMetadata.get(id.data);
      return row ? parseMetadata(row) : null;
    },
    readSlice(artifactId, { query, ...pagination }) {
      const id = ArtifactIdSchema.parse(artifactId);
      const criteria = sliceQuery.parse({ ...pagination, q: query });
      const row = getContent.get(id);
      return row ? sliceArtifact(row, criteria) : null;
    },
  };
}

export function getArtifactWithSlice(db: Database.Database, artifactId: string, query: SliceQuery) {
  const id = ArtifactIdSchema.parse(artifactId);
  const criteria = sliceQuery.parse(query);
  const row = db.prepare<[string], MetadataRow & ContentRow>(
    `SELECT ${metadataColumns}, content FROM artifacts WHERE id = ?`,
  ).get(id);
  if (!row) return null;
  const { content, ...metadata } = row;
  return { artifact: parseMetadata(metadata), slice: sliceArtifact({ content }, criteria) };
}
