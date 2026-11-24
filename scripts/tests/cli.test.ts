import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIn, inGitFixture } from './git-fixture.js';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the CLI contract tests through npm.');

const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'npm_config_loglevel'));

function invoke(command: string, flags: string[] = [], cwd?: string) {
  return spawnSync(process.execPath, [npm, 'run', 'cli', '--', command, ...flags], {
    cwd,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function repoStatus() {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  expect(status.status).toBe(0);
  return status.stdout;
}

describe('M0-06 npm CLI contract', () => {
  it.each(['env-check', 'guardrails', 'smoke', 'graph'])(
    'emits parseable stdout on both npm invocations of %s',
    (command) => {
      const before = repoStatus();
      const outputs = Array.from({ length: 2 }, () => {
        const result = invoke(command, ['--json']);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ ok: true });
        if (command === 'smoke') {
          expect(output).toMatchObject({ statusCode: 200, health: { sqlite: 'ok' } });
          expect(Date.parse(output.health.timestamp)).not.toBeNaN();
          return { ...output, health: { ...output.health, timestamp: null } };
        }
        if (command === 'graph' && !existsSync('docs/feature-graph.json')) {
          expect(output).toEqual({
            ok: true, present: false, skipped: true, activeMilestone: null, milestones: [],
            summary: { total: 0, required: 0, covered: 0, missing: 0, deferred: 0 },
            nodes: [], edges: [], violations: [],
          });
        }
        return output;
      });
      expect(outputs[0]).toEqual(outputs[1]);
      expect(repoStatus()).toBe(before);
    },
    12000,
  );

  it('reports usage on stderr with a nonzero exit for an unknown command', () => {
    const result = invoke('unknown-cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });

  it('lists the graph command in help', () => {
    const result = invoke('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('env-check|guardrails|smoke|graph');
  });
});

describe('G06-08 graph CLI in a Git repository', () => {
  it('reports valid, missing, and cyclic graphs with parseable JSON', () => inGitFixture((cwd) => {
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

    function checkGraph(expectedExit: number) {
      const response = invoke('graph', ['--json'], cwd);
      expect(response.error).toBeUndefined();
      expect(response.status, response.stderr).toBe(expectedExit);
      expect(response.stderr).toBe('');
      return JSON.parse(response.stdout);
    }

    expect(checkGraph(0)).toMatchObject({
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
    const human = invoke('graph', [], cwd);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('[COVERED] ' + first);
    expect(human.stdout).toContain('[DEFERRED] ' + second);

    gitIn(cwd, 'add', '--', graphPath);
    expect(checkGraph(1)).toMatchObject({
      ok: false,
      violations: [expect.objectContaining({ rule: 'G-06', snapshot: 'index' })],
    });
    gitIn(cwd, 'add', '--', target);

    writeFileSync(testFile, '// ' + first);
    expect(checkGraph(1)).toMatchObject({
      ok: false, present: true, summary: { missing: 1 },
      violations: [expect.objectContaining({ rule: 'G-06', message: expect.stringContaining(first) })],
    });

    writeFileSync(graphFile, JSON.stringify({
      ...graph,
      activeMilestone: 'M0',
      edges: [...graph.edges, { from: second, to: first }],
    }));
    expect(checkGraph(1)).toMatchObject({
      ok: false, present: true,
      violations: [expect.objectContaining({ rule: 'G-06', message: expect.stringContaining('Cycle') })],
    });
  }, ['.npmrc', 'scripts/cli/index.mjs']), 12000);
});
