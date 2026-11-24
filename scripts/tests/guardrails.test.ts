import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../apps/server/src/config/env.js';
import { scanGuardrails } from '../lib/guardrails.mjs';

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

const envSchema = 'apps/server/src/config/env.ts';
const envExample = '.env.example';
const guardrailEntry = 'scripts/check-guardrails.mjs';

function inGitFixture(test: (cwd: string) => void) {
  const fixtureParent = resolve('node_modules');
  const cwd = mkdtempSync(join(fixtureParent, 'm0-guardrails-'));
  if (dirname(cwd) !== fixtureParent) throw new Error('Unexpected Git fixture directory.');

  try {
    for (const path of [envSchema, envExample, guardrailEntry, 'scripts/lib/guardrails.mjs', 'package.json']) {
      const target = join(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(path, target);
    }
    mkdirSync(join(cwd, 'node_modules'));
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    gitIn(cwd, 'init', '--quiet');
    gitIn(cwd, 'config', 'core.autocrlf', 'false');
    gitIn(cwd, 'add', '--', envSchema, envExample);
    test(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function gitIn(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, windowsHide: true });
}

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
