import type { ArtifactStorePort } from '@mini-agent-run/agent';
import {
  ArtifactIdSchema, ArtifactMetaSchema, LogLevelSchema, MAX_ARTIFACT_SLICE_LINES, type ArtifactMeta,
} from '@mini-agent-run/shared';
import { classifyTraceLine } from '@mini-agent-run/tools';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sliceTextContent } from '../fs/file-slice.js';

type SqliteText = string | Buffer;
type MetadataRow = Omit<ArtifactMeta, 'summary' | 'sourceTool' | 'title'> & {
  sourceTool: SqliteText;
  title: SqliteText;
  summaryJson: string;
};
type ContentRow = { content: SqliteText };
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

function encodeSqliteText(text: string): SqliteText {
  // SQLite TEXT encodes as UTF-8. A UTF-16 BLOB preserves lone code units when present.
  return /[\uD800-\uDFFF]/u.test(text) ? Buffer.from(text, 'utf16le') : text;
}

function decodeSqliteText(value: SqliteText): string {
  return typeof value === 'string' ? value : value.toString('utf16le');
}

function parseMetadata({ summaryJson, sourceTool, title, ...metadata }: MetadataRow) {
  return ArtifactMetaSchema.parse({
    ...metadata, sourceTool: decodeSqliteText(sourceTool), title: decodeSqliteText(title), summary: JSON.parse(summaryJson),
  });
}

function sliceArtifact({ content }: ContentRow, query: SliceQuery) {
  return sliceTextContent(decodeSqliteText(content), query, classifyTraceLine);
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
      const { summary, sourceTool, title, ...metadata } = artifact;
      insert.run({
        ...metadata,
        sourceTool: encodeSqliteText(sourceTool),
        title: encodeSqliteText(title),
        content: encodeSqliteText(raw),
        summaryJson: JSON.stringify(summary),
      });
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
