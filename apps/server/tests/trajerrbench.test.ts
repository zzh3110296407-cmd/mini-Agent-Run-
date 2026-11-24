import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createTrajectoryTools, importTrajErrBench } from '../src/db/trajerrbench.js';

const offlineAnswer = 'OfflineAnswerMarker732';
const extraAnswer = 'UnexpectedMetadataMarker619';
const holdoutText = 'HoldoutOnlyMarker424';
const longText = '中'.repeat(8191) + '🧪\n' + '普通日志行，保留完整证据🧪\n'.repeat(10000) + '最终错误证据';
const runId = 'tau2bench:' + 'development-case-'.repeat(7);
let directory: string;
let train: string;
let database: string;

function trajectory(id: string, content: string) {
  return {
    metadata: {
      task_description: 'Investigate a failed action',
      reward: 0,
      annotation: { critical_error_step: 1, critical_error_type: offlineAnswer },
      extra: { pair_id: id, source_benchmark: 'tau2bench', unknown: extraAnswer },
    },
    messages: [
      { step: 0, role: 'user', name: 'user', content: 'A request' },
      { step: 1, role: 'tool', name: 'check', content, annotation: extraAnswer },
    ],
    raw: extraAnswer,
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mini-agent-trajerrbench-'));
  train = join(directory, 'train');
  database = join(directory, 'data', 'agent-run.db');
  mkdirSync(train);
  mkdirSync(join(directory, 'test'));
  writeFileSync(join(train, 'case.json'), JSON.stringify(trajectory(runId, longText)));
  writeFileSync(join(directory, 'test', 'holdout.json'), JSON.stringify(trajectory('holdout', holdoutText)));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('TrajErrBench data boundary', () => {
  it('keeps answer fields, arbitrary metadata, and holdout data out of storage and each tool', () => {
    expect(importTrajErrBench(train, database)).toEqual({ runCount: 1, stepCount: 2 });
    const tools = createTrajectoryTools(database);
    const results = [
      tools.listRuns({}),
      tools.getRunDetail({ runId }),
      tools.searchRuntimeLogs({ query: '最终错误证据' }),
      tools.readRuntimeLog({ runId, step: 1 }),
    ];
    expect(results.every(Boolean)).toBe(true);
    expect(tools.listRuns({}).map((run) => run.runId)).toEqual([runId]);
    expect(tools.getRunDetail({ runId: 'holdout' })).toBeNull();
    const visible = JSON.stringify(results);
    const stored = readFileSync(database);
    for (const marker of [offlineAnswer, extraAnswer, holdoutText, 'critical_error_step', 'critical_error_type']) {
      expect(visible).not.toContain(marker);
      expect(stored.includes(Buffer.from(marker))).toBe(false);
      expect(tools.searchRuntimeLogs({ query: marker })).toEqual([]);
    }
    expect(readFileSync(join(train, 'case.json'), 'utf8')).toContain(offlineAnswer);
  });

  it('finds the tail of a large Chinese log and reads the full text in bounded chunks', () => {
    importTrajErrBench(train, database);
    const tools = createTrajectoryTools(database);
    expect(tools.listRuns({})[0]?.logBytes).toBeGreaterThan(300000);
    expect(tools.searchRuntimeLogs({ query: '最终错误证据', runId })).toEqual([
      expect.objectContaining({ step: 1, excerpt: expect.stringContaining('最终错误证据') }),
    ]);
    expect(tools.searchRuntimeLogs({ query: '最终' })).toHaveLength(1);
    expect(tools.readRuntimeLog({ runId, step: 1, offset: 8192 })).toBeNull();

    let text = '';
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = tools.readRuntimeLog({ runId, step: 1, offset });
      if (!chunk) throw new Error('Expected a log chunk.');
      expect(chunk.text.length).toBeLessThanOrEqual(8192);
      expect(/[\uD800-\uDFFF]/u.test(chunk.text)).toBe(false);
      if (chunk.nextOffset !== null) expect(chunk.nextOffset).toBeGreaterThan(offset);
      text += chunk.text;
      offset = chunk.nextOffset;
    }
    expect(text).toBe(longText);
  });

  it('replaces an imported snapshot and leaves the last good version usable on invalid input', () => {
    importTrajErrBench(train, database);
    const tools = createTrajectoryTools(database);
    writeFileSync(join(train, 'invalid.json'), '{');
    expect(() => importTrajErrBench(train, database)).toThrow('invalid.json');
    expect(tools.searchRuntimeLogs({ query: '最终错误证据' })).toHaveLength(1);

    rmSync(join(train, 'invalid.json'));
    writeFileSync(join(train, 'case.json'), JSON.stringify(trajectory(runId, 'Replacement log')));
    importTrajErrBench(train, database);
    importTrajErrBench(train, database);
    expect(tools.listRuns({})).toHaveLength(1);
    expect(tools.searchRuntimeLogs({ query: '最终错误证据' })).toEqual([]);
    expect(tools.searchRuntimeLogs({ query: 'Replacement' })).toHaveLength(1);
  });

  it('serves the same bounded tools through the local HTTP app', async () => {
    const app = buildApp(createTrajectoryTools(database));
    const base = '/api/datasets/trajerrbench';
    const run = base + '/runs/' + encodeURIComponent(runId);

    try {
      expect((await app.inject(base + '/runs')).statusCode).toBe(503);
      importTrajErrBench(train, database);
      const list = await app.inject(base + '/runs');
      const page = await app.inject(run + '?limit=1');
      const nextPage = await app.inject(run + '?after=0&limit=1');
      const search = await app.inject(base + '/search?query=' + encodeURIComponent('最终错误证据'));
      const chunk = await app.inject(run + '/logs/1?offset=0');

      for (const response of [list, page, nextPage, search, chunk]) {
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('application/json');
        expect(response.payload).not.toMatch(/annotation|critical_error|OfflineAnswerMarker732/);
      }
      expect(page.json()).toMatchObject({ steps: [{ step: 0 }], nextAfter: 0 });
      expect(nextPage.json()).toMatchObject({ steps: [{ step: 1 }], nextAfter: null });
      expect((await app.inject(run + '/logs/1?offset=-1')).statusCode).toBe(400);
      expect((await app.inject(base + '/runs/missing')).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
