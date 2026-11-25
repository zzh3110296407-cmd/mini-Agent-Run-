import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIn, inGitFixture, runNode } from './git-fixture.js';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the CLI contract tests through npm.');

const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'npm_config_loglevel'));

const invoke = (command: string, flags: string[] = [], cwd?: string) =>
  runNode([npm, 'run', 'cli', '--', command, ...flags], { cwd, env });

function repoStatus() {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  expect(status.status).toBe(0);
  return status.stdout;
}

describe('M0-06 npm CLI contract', () => {
  it.concurrent.each(['env-check', 'guardrails', 'smoke', 'graph'])(
    'emits parseable stdout on both npm invocations of %s',
    async (command) => {
      const before = repoStatus();
      async function parsedOutput() {
        const result = await invoke(command, ['--json']);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ ok: true });
        if (command === 'smoke') {
          expect(output).toMatchObject({ statusCode: 200, health: { sqlite: 'ok' } });
          expect(Date.parse(output.health.timestamp)).not.toBeNaN();
          return { ...output, health: { ...output.health, timestamp: null } };
        }
        if (command === 'graph') {
          if (existsSync('docs/feature-graph.json')) {
            expect(output).toMatchObject({ ok: true, present: true, skipped: false, violations: [] });
            expect(output.summary.missing).toBe(0);
            expect(output.summary.required).toBeGreaterThanOrEqual(1);
            expect(output.summary.covered).toBe(output.summary.required);
          } else {
            expect(output).toEqual({
              ok: true, present: false, skipped: true, activeMilestone: null, milestones: [],
              summary: { total: 0, required: 0, covered: 0, missing: 0, deferred: 0 },
              nodes: [], edges: [], violations: [],
            });
          }
        }
        return output;
      }
      const first = await parsedOutput();
      const second = await parsedOutput();
      expect(first).toEqual(second);
      expect(repoStatus()).toBe(before);
    },
    12000,
  );

  it.concurrent('reports usage on stderr with a nonzero exit for an unknown command', async () => {
    const result = await invoke('unknown-cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });

  it.concurrent('lists the graph command in help', async () => {
    const result = await invoke('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('env-check|guardrails|smoke|graph');
  });
});

describe('G06-08 graph CLI in a Git repository', () => {
  it.concurrent('reports valid, missing, and cyclic graphs with parseable JSON', () => inGitFixture(async (cwd) => {
    const first = ['F01', 'DEMO'].join('_');
    const second = ['F02', 'DEMO'].join('_');
    const target = 'scripts/tests/demo.test.ts';
    const graphPath = 'docs/feature-graph.json';
    const graph = {
      milestones: ['M0', 'M1', 'M2'],
      activeMilestone: 'M1',
      nodes: [first, second].map((id, index) => ({
        id, name: id, milestone: index === 0 ? 'M1' : 'M2', packages: ['apps/server'], summary: 'Fixture feature',
      })),
      edges: [{ from: first, to: second }],
    };
    const graphFile = join(cwd, graphPath);
    const testFile = join(cwd, target);
    mkdirSync(dirname(graphFile), { recursive: true });
    mkdirSync(dirname(testFile), { recursive: true });

    writeFileSync(graphFile, JSON.stringify(graph));
    writeFileSync(testFile, 'it("[' + first + ']", () => {});');

    async function checkGraph(expectedExit: number) {
      const response = await invoke('graph', ['--json'], cwd);
      expect(response.error).toBeUndefined();
      expect(response.status, response.stderr).toBe(expectedExit);
      expect(response.stderr).toBe('');
      return JSON.parse(response.stdout);
    }

    expect(await checkGraph(0)).toMatchObject({
      ok: true, present: true, skipped: false, activeMilestone: 'M1',
      milestones: ['M0', 'M1', 'M2'],
      summary: { total: 2, required: 1, covered: 1, missing: 0, deferred: 1 },
      nodes: [
        { id: first, covered: true, testFiles: [target] },
        { id: second, required: false, covered: false, testFiles: [] },
      ],
      edges: graph.edges,
      violations: [],
    });
    const human = await invoke('graph', [], cwd);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('[COVERED] ' + first);
    expect(human.stdout).toContain('[DEFERRED] ' + second);

    gitIn(cwd, 'add', '--', graphPath);
    expect(await checkGraph(1)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ rule: 'G-06', snapshot: 'index' })],
    });
    gitIn(cwd, 'add', '--', target);

    writeFileSync(testFile, '// ' + first);
    expect(await checkGraph(1)).toMatchObject({
      ok: false, present: true, summary: { missing: 1 },
      violations: [expect.objectContaining({ rule: 'G-06', message: expect.stringContaining(first) })],
    });

    writeFileSync(graphFile, JSON.stringify({
      ...graph,
      activeMilestone: 'M0',
      edges: [...graph.edges, { from: second, to: first }],
    }));
    expect(await checkGraph(1)).toMatchObject({
      ok: false, present: true,
      violations: [expect.objectContaining({ rule: 'G-06', message: expect.stringContaining('Cycle') })],
    });
  }, ['.npmrc', 'scripts/cli/index.mjs']), 12000);
});
