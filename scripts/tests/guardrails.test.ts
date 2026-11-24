import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ESLint } from 'eslint';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../apps/server/src/config/env.js';
import { inspectFeatureGraph, scanGuardrails } from '../lib/guardrails.mjs';
import { envExample, envSchema, gitIn, guardrailEntry, inGitFixture } from './git-fixture.js';

const lint = new ESLint();

async function lintRuleIds(filePath: string, code: string) {
  const results = await lint.lintText(code, { filePath });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId));
}

describe('M0 ESLint guardrails', () => {
  it('G-02a rejects raw HTML and accepts Vue text interpolation', async () => {
    const file = 'apps/web/src/HealthProbe.vue';
    const script = '<script setup lang="ts">const raw = "sample";</script>';

    expect(await lintRuleIds(file, script + '<template><div v-html="raw" /></template>'))
      .toContain('vue/no-v-html');
    expect(await lintRuleIds(file, script + '<template><div>{{ raw }}</div></template>'))
      .toEqual([]);
  });

  it('G-02b rejects explicit any and accepts unknown', async () => {
    const file = 'packages/shared/src/probe.ts';

    expect(await lintRuleIds(file, 'export const value: any = 1;'))
      .toContain('@typescript-eslint/no-explicit-any');
    expect(await lintRuleIds(file, 'export const value: unknown = 1;')).toEqual([]);
  });

  it.each([
    {
      rule: 'G-03a',
      file: 'apps/web/src/probe.ts',
      blocked: ['fastify', 'better-sqlite3', 'node:fs', 'fs', '../../server/src/app.js',
        '@mini-agent-run/server/private'],
      allowed: ['vue', '@mini-agent-run/shared'],
    },
    {
      rule: 'G-03b',
      file: 'packages/shared/src/probe.ts',
      blocked: ['vue', 'fastify', '../../../apps/web/src/main.js'],
      allowed: ['zod'],
    },
    {
      rule: 'G-03c',
      file: 'apps/server/src/runtime/probe.ts',
      blocked: ['better-sqlite3', 'fastify', 'openai'],
      allowed: ['@mini-agent-run/shared', './interfaces.js'],
    },
  ])('$rule enforces the import boundary in $file', async ({ file, blocked, allowed }) => {
    for (const name of blocked) {
      expect(await lintRuleIds(file, 'import ' + JSON.stringify(name) + ';'))
        .toContain('no-restricted-imports');
    }
    for (const name of allowed) {
      expect(await lintRuleIds(file, 'import ' + JSON.stringify(name) + ';')).toEqual([]);
    }
  });

  it('G-03 also rejects loading a restricted dependency dynamically', async () => {
    const file = 'apps/web/src/probe.ts';

    expect(await lintRuleIds(file, 'void import("node:fs");')).toContain('no-restricted-syntax');
    expect(await lintRuleIds(file, 'void import("vue");')).toEqual([]);
  });

  it('G-03c resolves equivalent Runtime import paths before checking the boundary', async () => {
    const file = 'apps/server/src/runtime/probe.ts';

    for (const specifier of ['../db/smoke.js', './../db/smoke.js', './../config/env.js']) {
      expect(await lintRuleIds(file, 'import ' + JSON.stringify(specifier) + ';'))
        .toEqual(['workspace/runtime-boundary']);
    }
    expect(await lintRuleIds(file, 'void import("./../db/smoke.js");'))
      .toEqual(['workspace/runtime-boundary']);
    expect(await lintRuleIds(
      'apps/server/src/runtime/nested/probe.ts',
      'export { checkSqliteSmoke } from "./../../db/smoke.js";',
    )).toEqual(['workspace/runtime-boundary']);
    expect(await lintRuleIds(file, 'import "./nested/../interfaces.js";')).toEqual([]);
  });
});

const template = ENV_KEYS.map((key) => key + '=placeholder').join('\n');
const file = 'apps/server/src/probe.ts';
const testFile = 'apps/server/tests/probe.test.ts';
const graphPath = 'docs/feature-graph.json';

function check(
  overrides: {
    files?: Record<string, string>;
    trackedPaths?: string[];
    indexFiles?: Record<string, string>;
    presentPaths?: string[];
  } = {},
) {
  return scanGuardrails({
    envKeys: ENV_KEYS,
    files: new Map(Object.entries({ '.env.example': template, ...overrides.files })),
    trackedPaths: overrides.trackedPaths ?? [],
    indexFiles: new Map(Object.entries(overrides.indexFiles ?? {})),
    presentPaths: overrides.presentPaths ?? [],
  });
}

describe('M0 repository guardrails', () => {
  it('G-04a finds a credential in each snapshot and accepts the example placeholder', () => {
    const secret = ['sk', 'A'.repeat(32)].join('-');
    const source = '\nexport const key = "' + secret + '";';
    const working = check({ files: { [file]: source } });
    const staged = check({ indexFiles: { [file]: source } });

    expect(working.violations).toEqual([expect.objectContaining({ rule: 'G-04a', file, line: 2 })]);
    expect(staged.violations).toEqual([
      expect.objectContaining({ rule: 'G-04a', file, line: 2, snapshot: 'index' }),
    ]);
    expect(JSON.stringify([working, staged])).not.toContain(secret);
    expect(check({ files: { '.env.example': template.replace('LLM_API_KEY=placeholder',
      'LLM_API_KEY=your_api_key_here') } }).ok).toBe(true);
  });

  it('G-04b rejects tracked environment files and competing lockfiles or hooks', () => {
    const trackedPaths = ['.env', 'apps/server/.env.local', 'pnpm-lock.yaml', 'yarn.lock'];
    const result = check({ trackedPaths, presentPaths: ['.husky'] });

    expect(result.violations.map(({ file }: { file: string }) => file))
      .toEqual([...trackedPaths, '.husky']);
    expect(result.violations.every(({ rule }: { rule: string }) => rule === 'G-04b')).toBe(true);
    expect(check({ trackedPaths: ['.env.example', 'package-lock.json'] }).ok).toBe(true);
  });

  it('G-04c detects missing, extra, and duplicate template keys', () => {
    const drift = template.replace('PORT=placeholder', 'UNEXPECTED=placeholder')
      + '\nDB_PATH=second';
    const result = check({ files: { '.env.example': drift } });

    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'G-04c', message: expect.stringContaining('PORT') }),
      expect.objectContaining({ rule: 'G-04c', message: expect.stringContaining('UNEXPECTED') }),
      expect.objectContaining({ rule: 'G-04c', message: expect.stringContaining('Duplicate') }),
    ]));
    expect(result.violations).toHaveLength(3);
    expect(check().ok).toBe(true);
  });

  it.each([
    ['@ts-', 'ignore'],
    ['@ts-', 'expect-error'],
    ['@ts-', 'nocheck'],
    ['eslint-', 'disable'],
    ['eslint-', 'disable-next-line'],
    ['eslint-', 'disable-line'],
  ])('G-05a rejects an undeclared %s%s directive', (prefix, suffix) => {
    const token = prefix + suffix;
    const source = '// ' + token;
    const waivers = JSON.stringify({ waivers: [
      { rule: 'G-05a', file, line: 1, token, reason: 'Sample approval' },
    ] });
    const waiverPath = 'scripts/guardrail-waivers.json';

    expect(check({ files: { [file]: source } }).violations).toEqual([
      expect.objectContaining({ rule: 'G-05a', file, line: 1 }),
    ]);
    expect(check({ files: { [file]: source, [waiverPath]: waivers } }).ok).toBe(true);
    expect(check({ files: { [file]: '\n' + source, [waiverPath]: waivers } }).ok).toBe(false);
  });

  it.each([
    ['it', 'skip'],
    ['test', 'only'],
    ['describe', 'skip'],
    ['describe', 'only'],
  ])('G-05b rejects %s with modifier %s and accepts ordinary tests', (runner, modifier) => {
    const testCall = [runner, modifier].join('.') + '("example", () => {});';
    const normal = runner + '("example", () => {});';

    expect(check({ files: { [testFile]: testCall } }).violations).toEqual([
      expect.objectContaining({ rule: 'G-05b', file: testFile, line: 1 }),
    ]);
    expect(check({ files: { [testFile]: normal } }).ok).toBe(true);
  });

  it.each(['skip', 'only'])('G-05b recognizes Vitest aliases with modifier %s', (modifier) => {
    const token = ['scenario', modifier].join('.');
    const imported = 'import { it as scenario } from "vitest";\n';
    const call = '("example", () => {});';
    const source = imported + token + call;
    const waiverPath = 'scripts/guardrail-waivers.json';
    const waivers = JSON.stringify({ waivers: [
      { rule: 'G-05b', file: testFile, line: 2, token, reason: 'Sample approval' },
    ] });

    expect(check({ files: { [testFile]: source } }).violations).toEqual([
      expect.objectContaining({ rule: 'G-05b', file: testFile, line: 2 }),
    ]);
    expect(check({ files: { [testFile]: source, [waiverPath]: waivers } }).ok).toBe(true);
    expect(check({ files: { [testFile]: '\n' + source, [waiverPath]: waivers } }).ok).toBe(false);
    expect(check({ files: { [testFile]: imported + 'scenario' + call } }).ok).toBe(true);

    const localObject = 'const test = { ' + modifier + '() {} };\n'
      + ['test', modifier].join('.') + '();';
    expect(check({ files: { [testFile]: localObject } }).ok).toBe(true);

    const shadowed = imported + 'function demo(scenario) { ' + token + '(); }';
    expect(check({ files: { [testFile]: shadowed } }).ok).toBe(true);
  });

  it.each([
    ['it', 'skip'],
    ['test.concurrent', 'only'],
    ['describe', 'skip'],
    ['suite', 'only'],
  ])('G-05b recognizes Vitest namespace runner %s with modifier %s', (runner, modifier) => {
    const imported = 'import * as suiteApi from "vitest";\n';
    const runnerPath = 'suiteApi.' + runner;
    const token = [runnerPath, modifier].join('.');
    const call = '("example", () => {});';
    const source = imported + token + call;
    const waiverPath = 'scripts/guardrail-waivers.json';
    const waiver = { rule: 'G-05b', file: testFile, line: 2, token, reason: 'Sample approval' };

    expect(check({ files: { [testFile]: source } }).violations).toEqual([
      expect.objectContaining({ rule: 'G-05b', file: testFile, line: 2 }),
    ]);
    expect(check({ files: { [testFile]: imported + runnerPath + call } }).ok).toBe(true);
    expect(check({ files: {
      [testFile]: source,
      [waiverPath]: JSON.stringify({ waivers: [waiver] }),
    } }).ok).toBe(true);
    expect(check({ files: {
      [testFile]: source,
      [waiverPath]: JSON.stringify({ waivers: [{ ...waiver, token: [runner, modifier].join('.') }] }),
    } }).ok).toBe(false);
  });

  it('G-05b accepts same-named methods outside a Vitest namespace binding', () => {
    const call = ['suiteApi', 'it', 'skip'].join('.') + '();';
    const object = 'const suiteApi = { it: { skip() {} } };\n';
    const imported = 'import * as suiteApi from "vitest";\n';

    const accepted = [
      object + call,
      imported + 'function demo() { ' + object + call + ' }',
      'import * as suiteApi from "./other.js";\n' + call,
    ];
    for (const source of accepted) {
      expect(check({ files: { [testFile]: source } }).ok).toBe(true);
    }
  });

  it('G-06 checks for an exact node ID in a test when the graph exists', () => {
    const featureId = ['F01', 'DEMO'].join('_');
    const graph = JSON.stringify({ nodes: [{ id: featureId }] });
    const files = { [graphPath]: graph };

    expect(check()).toMatchObject({ ok: true, skipped: ['G-06'] });
    expect(check({ files }).violations).toEqual([
      expect.objectContaining({ rule: 'G-06', file: graphPath, message: expect.stringContaining(featureId) }),
    ]);
    expect(check({ files: { ...files, [testFile]: featureId + '_OTHER' } }).ok).toBe(false);
    expect(check({ files: { ...files, [file]: featureId } }).ok).toBe(false);
    expect(check({ files: { ...files, [testFile]: 'it("' + featureId + '", () => {});' } }).ok).toBe(true);
    expect(check({ files: { [graphPath]: '{"nodes":[{}]}' } }).ok).toBe(false);
  });
});

function checkIn(cwd: string) {
  const result = spawnSync(process.execPath, [guardrailEntry, '--json'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return { status: result.status, stdout: result.stdout, body: JSON.parse(result.stdout) };
}

describe('M0 Git snapshot guardrails', () => {
  it('G-04a scans project npm configuration and redacts both snapshots', () => inGitFixture((cwd) => {
    const credential = ['sk', 'Synthetic'.repeat(4)].join('-');
    const npmrc = join(cwd, '.npmrc');
    const typescript = join(cwd, 'scripts', 'credential-probe.ts');
    const safe = 'loglevel=silent\n';
    const config = '//packages.invalid/:_authToken=' + credential + '\n';

    writeFileSync(typescript, 'export const key = ' + JSON.stringify(credential));
    const source = checkIn(cwd);
    expect(source.status).toBe(1);
    expect(source.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-04a', file: 'scripts/credential-probe.ts', line: 1 }),
    ]);
    expect(source.stdout).not.toContain(credential);
    unlinkSync(typescript);

    writeFileSync(npmrc, config);
    gitIn(cwd, 'add', '--', '.npmrc');
    const tracked = checkIn(cwd);
    expect(tracked.status).toBe(1);
    expect(tracked.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-04a', file: '.npmrc', line: 1 }),
    ]);
    expect(tracked.stdout).not.toContain(credential);

    writeFileSync(npmrc, safe);
    const indexOnly = checkIn(cwd);
    expect(indexOnly.status).toBe(1);
    expect(indexOnly.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-04a', file: '.npmrc', line: 1, snapshot: 'index' }),
    ]);
    expect(indexOnly.stdout).not.toContain(credential);

    gitIn(cwd, 'add', '--', '.npmrc');
    expect(checkIn(cwd)).toMatchObject({ status: 0, body: { ok: true, violations: [] } });
  }), 12000);

  it('G-04c pairs the template and schema within each Git snapshot', () => inGitFixture((cwd) => {
    const exampleFile = join(cwd, envExample);
    const schemaFile = join(cwd, envSchema);
    const initialTemplate = readFileSync(exampleFile, 'utf8');
    const initialSchema = readFileSync(schemaFile, 'utf8');
    const changedTemplate = initialTemplate + 'EXTRA=1\n';

    writeFileSync(exampleFile, changedTemplate);
    gitIn(cwd, 'add', '--', envExample);
    writeFileSync(exampleFile, initialTemplate);
    const indexDrift = checkIn(cwd);
    expect(indexDrift.status).toBe(1);
    expect(indexDrift.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-04c', file: envExample, snapshot: 'index' }),
    ]);

    gitIn(cwd, 'add', '--', envExample);
    writeFileSync(exampleFile, changedTemplate);
    const worktreeDrift = checkIn(cwd);
    expect(worktreeDrift.status).toBe(1);
    expect(worktreeDrift.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-04c', file: envExample }),
    ]);
    expect(worktreeDrift.body.violations[0]).not.toHaveProperty('snapshot', 'index');

    writeFileSync(schemaFile, initialSchema.replace('  PORT:', '  EXTRA: z.string(),\n  PORT:'));
    gitIn(cwd, 'add', '--', envExample, envSchema);
    writeFileSync(exampleFile, initialTemplate);
    writeFileSync(schemaFile, initialSchema);
    const matched = checkIn(cwd);
    expect(matched.status, matched.stdout).toBe(0);
    expect(matched.body).toMatchObject({ ok: true, violations: [] });
  }), 12000);
});

const demoId = (number: number) => 'F' + String(number).padStart(2, '0') + '_DEMO';
const first = demoId(1);
const second = demoId(2);
const third = demoId(3);
const fourth = demoId(4);

function demoNode(id: string, milestone = 'M1') {
  return { id, name: id, milestone, packages: ['apps/server'], summary: 'Fixture feature' };
}

function stagedGraph(activeMilestone = 'M0') {
  return {
    version: '1.0',
    milestones: ['M0', 'M1', 'M2'],
    activeMilestone,
    nodes: [demoNode(first), demoNode(second, 'M2')],
    edges: [{ from: first, to: second, relation: 'depends_on' }],
  };
}

function testTitle(id: string) {
  return 'it("[ ' + id + ' ] covers a feature", () => {});';
}

function inspect(graph: unknown, files: [string, string][] = []) {
  return inspectFeatureGraph(JSON.stringify(graph), new Map(files));
}

describe('G-06 staged Feature Graph', () => {
  const base = stagedGraph();

  it.each([
    [{ nodes: [] }, 'nodes'],
    [{ nodes: [null] }, 'nodes'],
    [{ nodes: [{ id: first }], edges: [] }, 'milestones'],
    [{ ...base, version: ' ' }, 'version'],
    [{ ...base, milestones: undefined }, 'milestones'],
    [{ ...base, milestones: [] }, 'milestones'],
    [{ ...base, milestones: ['M0', 'M1', 'M1'] }, 'milestones'],
    [{ ...base, milestones: ['M0', 'M1', 'M 2'] }, 'milestones'],
    [{ ...base, activeMilestone: undefined }, 'activeMilestone'],
    [{ ...base, activeMilestone: null }, 'activeMilestone'],
    [{ ...base, activeMilestone: '' }, 'activeMilestone'],
    [{ ...base, activeMilestone: 'M99' }, 'activeMilestone'],
    [{ ...base, edges: undefined }, 'edges'],
    [{ ...base, nodes: [demoNode('1-invalid')] }, 'id'],
    [{ ...base, nodes: [demoNode(first), demoNode(first)] }, 'id'],
    [{ ...base, nodes: [demoNode(first, 'M99'), demoNode(second)] }, 'milestone'],
    [{ ...base, nodes: [{ ...demoNode(first), name: ' ' }, demoNode(second)] }, 'name'],
    [{ ...base, nodes: [{ ...demoNode(first), packages: [] }, demoNode(second)] }, 'packages'],
    [{ ...base, nodes: [{ ...demoNode(first), packages: ['apps/web', 'apps/web'] }, demoNode(second)] }, 'packages'],
    [{ ...base, nodes: [{ ...demoNode(first), packages: [' '] }, demoNode(second)] }, 'packages'],
    [{ ...base, edges: [{ from: first, to: demoId(99) }] }, 'to'],
    [{ ...base, edges: [{ from: demoId(99), to: first }] }, 'from'],
    [{ ...base, edges: [{ from: first, to: first }] }, 'Self-loop'],
    [{ ...base, edges: [...base.edges, ...base.edges] }, 'Duplicate edge'],
    [{ ...base, edges: [{ from: first, to: second, relation: '' }] }, 'relation'],
  ])('rejects an invalid graph field (%#)', (graph, field) => {
    expect(inspect(graph)).toMatchObject({
      ok: false, present: true, skipped: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ rule: 'G-06', message: expect.stringContaining(field) }),
      ]),
    });
  });

  it.each(['name', 'milestone', 'packages', 'summary'] as const)(
    'requires the %s field even for deferred nodes',
    (field) => {
      const nodes = [{ ...demoNode(first), [field]: undefined }, demoNode(second)];
      expect(inspect({ ...base, nodes })).toMatchObject({
        ok: false, violations: expect.arrayContaining([
          expect.objectContaining({ rule: 'G-06', message: expect.stringContaining(field) }),
        ]),
      });
    },
  );

  it('requires previous and active milestones while reporting deferred nodes', () => {
    const coveredFirst: [string, string][] = [[testFile, testTitle(first)]];

    expect(inspect(stagedGraph(), [])).toMatchObject({
      ok: true, summary: { total: 2, required: 0, covered: 0, missing: 0, deferred: 2 },
    });
    expect(inspect(stagedGraph('M1'), coveredFirst)).toMatchObject({
      ok: true, activeMilestone: 'M1',
      summary: { total: 2, required: 1, covered: 1, missing: 0, deferred: 1 },
      nodes: [
        { id: first, required: true, covered: true, testFiles: [testFile] },
        { id: second, required: false, covered: false, testFiles: [] },
      ],
    });
    expect(inspect(stagedGraph('M1'))).toMatchObject({
      ok: false, violations: [expect.objectContaining({ message: expect.stringContaining(first) })],
    });
    expect(inspect(stagedGraph('M2'), coveredFirst)).toMatchObject({
      ok: false, violations: [expect.objectContaining({ message: expect.stringContaining(second) })],
    });
    expect(inspect(stagedGraph('M2'), [[testFile, testTitle(second)]])).toMatchObject({
      ok: false, violations: [expect.objectContaining({ message: expect.stringContaining(first) })],
    });
    expect(inspect(stagedGraph('M2'), [[testFile, testTitle(first) + testTitle(second)]])).toMatchObject({
      ok: true, summary: { total: 2, required: 2, covered: 2, missing: 0, deferred: 0 },
    });
  });

  it.each([[first, second], [first, second, third]])(
    'reports a cycle with deferred nodes (%#)',
    (...cycle) => {
      const edges = cycle.map((from, index) => ({ from, to: cycle[(index + 1) % cycle.length] }));
      const nodes = cycle.map((id) => demoNode(id));
      expect(inspect({ ...base, nodes, edges })).toMatchObject({
        ok: false,
        violations: [expect.objectContaining({
          rule: 'G-06', message: expect.stringContaining('Cycle detected: ' + [...cycle, cycle[0]].join(' -> ')),
        })],
      });
    },
  );

  it('accepts a diamond spanning the active and deferred stages', () => {
    const nodes = [demoNode(first), demoNode(second), demoNode(third, 'M2'), demoNode(fourth, 'M2')];
    const edges = [[first, second], [first, third], [second, fourth], [third, fourth]]
      .map(([from, to]) => ({ from, to }));
    const files: [string, string][] = [[testFile, testTitle(first) + testTitle(second)]];
    const graph = { ...base, nodes, edges, activeMilestone: 'M1' };

    expect(inspect(graph, files)).toMatchObject({ ok: true, summary: { deferred: 2 } });
    expect(inspect({ ...graph, activeMilestone: 'M2' }, files)).toMatchObject({
      ok: false, summary: { missing: 2 },
    });
  });

  it('accepts generated DAGs and detects a back edge on each generated graph', () => {
    const dag = fc.integer({ min: 2, max: 8 }).chain((size) => {
      const ids = Array.from({ length: size }, (_, i) => demoId(i + 1));
      const forward = ids.flatMap((from, i) => ids.slice(i + 1).map((to) => ({ from, to })));
      return fc.tuple(fc.constant(ids), fc.subarray(forward, { minLength: 1 }), fc.nat());
    });

    fc.assert(fc.property(dag, ([ids, edges, choice]) => {
      const graph = { ...base, nodes: ids.map((id) => demoNode(id)), edges };
      expect(inspect(graph)).toMatchObject({ ok: true, violations: [] });
      const forward = edges[choice % edges.length];
      const cyclic = { ...graph, edges: [...edges, { from: forward.to, to: forward.from }] };
      expect(inspect(cyclic)).toMatchObject({
        ok: false, violations: [expect.objectContaining({ rule: 'G-06', message: expect.stringContaining('Cycle') })],
      });
    }), { seed: 20261124, numRuns: 100 });
  });

  it.each([
    ['single-line comment', '// "' + first + '"'],
    ['block comment', '/* "' + first + '" */'],
    ['template expression comment', 'it(`case ${0 /* "' + first + '" */}`, () => {});'],
    ['regular expression', 'const decoy = /"' + first + '"/;'],
    ['partial prefix', testTitle(first + '_OTHER')],
    ['partial suffix', testTitle('OTHER-' + first)],
    ['identifier', 'const ' + first + ' = 1;'],
  ])('ignores references in a %s', (_label, source) => {
    const result = check({ files: {
      [graphPath]: JSON.stringify(stagedGraph('M1')), [testFile]: source, [file]: testTitle(first),
    } });
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'G-06', message: expect.stringContaining(first) }),
    ]);
  });

  it('accepts literals including template heads, middles and tails in sorted test files', () => {
    const head = 'it(`' + first + ' ${0} tail`, () => {});';
    const middle = 'it(`head ${ { x: 0 } } ' + first + ' ${1} tail`, () => {});';
    const tail = 'it(`head ${`nested ${0}`} ' + first + '`, () => {});';
    const literal = 'describe(`' + first + ' suite`, () => {});';
    const files: [string, string][] = [
      ['scripts/tests/tail.test.ts', tail], ['scripts/tests/middle.test.ts', middle],
      ['scripts/tests/literal.test.ts', literal], ['scripts/tests/head.test.ts', head],
      [testFile, 'it.each(["' + first + '"])("case", () => {});'],
    ];
    expect(inspect(stagedGraph('M1'), files)).toMatchObject({
      ok: true, nodes: [{ id: first, covered: true, testFiles: files.map(([path]) => path).sort() },
        { id: second, required: false, testFiles: [] }],
    });
  });
});

describe('G-06 Git snapshots', () => {
  it('matches only files and graph contents in each snapshot', () => inGitFixture((cwd) => {
    const graph = stagedGraph('M1');
    const graphFile = join(cwd, graphPath);
    const test = join(cwd, testFile);
    mkdirSync(dirname(graphFile), { recursive: true });
    mkdirSync(dirname(test), { recursive: true });

    writeFileSync(graphFile, JSON.stringify(graph));
    writeFileSync(test, testTitle(first));
    gitIn(cwd, 'add', '--', graphPath);
    const unstagedTest = checkIn(cwd);
    expect(unstagedTest.status).toBe(1);
    expect(unstagedTest.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-06', snapshot: 'index', message: expect.stringContaining(first) }),
    ]);

    gitIn(cwd, 'add', '--', testFile);
    expect(checkIn(cwd)).toMatchObject({ status: 0, body: { ok: true, skipped: [] } });

    const cycle = [...graph.edges, { from: second, to: first, relation: 'depends_on' }];
    writeFileSync(graphFile, JSON.stringify({ ...graph, edges: cycle }));
    gitIn(cwd, 'add', '--', graphPath);
    writeFileSync(graphFile, JSON.stringify(graph));
    const indexCycle = checkIn(cwd);
    expect(indexCycle.status).toBe(1);
    expect(indexCycle.body.violations).toEqual([
      expect.objectContaining({ rule: 'G-06', snapshot: 'index', message: expect.stringContaining('Cycle') }),
    ]);

    gitIn(cwd, 'add', '--', graphPath);
    writeFileSync(test, '// ' + first);
    const worktreeMissing = checkIn(cwd);
    expect(worktreeMissing.status).toBe(1);
    expect(worktreeMissing.body.violations).toEqual([
      { rule: 'G-06', file: graphPath, line: 1, message: 'No test references feature ID ' + first + '.' },
    ]);
    unlinkSync(test);
    expect(checkIn(cwd).body.violations).toEqual(worktreeMissing.body.violations);

    writeFileSync(test, testTitle(first));
    unlinkSync(graphFile);
    expect(checkIn(cwd)).toMatchObject({ status: 0, body: { ok: true, skipped: [] } });
  }), 12000);
});
