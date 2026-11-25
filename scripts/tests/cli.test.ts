import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitIn, inGitFixture, runNode } from './git-fixture.js';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the CLI contract tests through npm.');

const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'npm_config_loglevel'));

const invoke = (command: string, flags: string[] = [], cwd?: string, overrides: NodeJS.ProcessEnv = {}) =>
  runNode([npm, 'run', 'cli', '--', command, ...flags], { cwd, env: { ...env, ...overrides } });

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

describe('M1.5 tools-smoke CLI contract', () => {
  function success(result: Awaited<ReturnType<typeof invoke>>, artifactSource: string) {
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    const data = JSON.parse(result.stdout);
    expect(data).toMatchObject({
      ok: true, artifactSource, artifactId: expect.stringMatching(/^art_[0-9a-f-]{36}$/), cascadeCleared: true,
    });
    expect(data.summaryBytes).toBeGreaterThan(0);
    expect(data.summaryBytes).toBeLessThanOrEqual(6144);
    expect(data.rawBytes).toBeGreaterThan(6144);
    return data;
  }

  it.concurrent('naturally offloads on two consecutive runs without changing Git status or the source', async () => {
    const before = repoStatus();
    const file = 'data/fixtures/diagnostic-demo/noisy-large-xss.log';
    const original = readFileSync(file);
    const defaults = { ALLOWED_TRACE_ROOTS: undefined };
    const first = success(await invoke('tools-smoke', ['--json'], undefined, defaults), 'search_logs');
    const second = success(await invoke('tools-smoke', ['--json'], undefined, defaults), 'search_logs');
    expect(first).toMatchObject({ sourceFile: 'noisy-large-xss.log', sourceLine: expect.any(Number) });
    expect(first.sourceLine).toBeGreaterThan(0);
    expect(first.artifactId).not.toBe(second.artifactId);
    expect({ ...first, artifactId: null }).toEqual({ ...second, artifactId: null });
    expect(repoStatus()).toBe(before);
    expect(readFileSync(file)).toEqual(original);
  }, 12000);

  it.concurrent('uses a labelled fallback for an allowed small directory and rejects an empty allowed directory', async () => {
    const parent = realpathSync.native(tmpdir());
    const dir = mkdtempSync(join(parent, 'm15-cli-small-'));
    if (dirname(dir) !== parent) throw new Error('Unexpected temporary fixture directory.');
    const small = join(dir, 'small fixture');
    const empty = join(dir, 'empty');
    const original = 'INFO small smoke input\nWARN harmless example\n';
    const file = join(small, 'test.log');
    const env = { ALLOWED_TRACE_ROOTS: dir };
    try {
      mkdirSync(small);
      mkdirSync(empty);
      writeFileSync(file, original);
      const before = repoStatus();
      const result = success(await invoke('tools-smoke', ['--path', small, '--json'], undefined, env), 'synthetic_fallback');
      expect(result).toMatchObject({ sourceFile: 'test.log', sourceLine: null });
      const failed = await invoke('tools-smoke', ['--json', '--path', empty], undefined, env);
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe('');
      expect(failed.stderr).toContain('no supported trace files');
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(repoStatus()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12000);

  it.concurrent('prints tools-smoke help and rejects out-of-scope paths and invalid flags on stderr', async () => {
    const help = await invoke('tools-smoke', ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('env-check|guardrails|smoke|graph|tools-smoke');
    const failures = await Promise.all([
      invoke('tools-smoke', ['--path', '../..', '--json'], undefined, { ALLOWED_TRACE_ROOTS: './data/fixtures' }),
      invoke('tools-smoke', ['--path']),
      invoke('tools-smoke', ['--path', 'a', '--path', 'b']),
      invoke('tools-smoke', ['--unknown']),
      invoke('smoke', ['--path', 'a']),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe('');
    }
    expect(failures[0]?.stderr).toContain('PATH_OUTSIDE_ALLOWED_ROOTS');
    for (const invalid of failures.slice(1)) expect(invalid.stderr).toContain('Usage:');
  }, 12000);
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

describe('M2.3 llm-smoke offline CLI contract', () => {
  it.concurrent('lists llm-smoke in help and rejects unsupported flags', async () => {
    const [help, invalid] = await Promise.all([
      invoke('llm-smoke', ['--help']), invoke('llm-smoke', ['--path', '.']),
    ]);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('tools-smoke|llm-smoke');
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('Usage:');
  });

  it.concurrent('rejects the placeholder before constructing a provider or starting a network request', async () => {
    const result = await invoke('llm-smoke', ['--json'], undefined, {
      LLM_API_KEY: 'your_api_key_here', LLM_BASE_URL: 'http://127.0.0.1:1', LLM_MODEL: 'fixture',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: 'LLM_NOT_CONFIGURED' });
    expect(result.stdout).not.toContain('your_api_key_here');
  });
});
