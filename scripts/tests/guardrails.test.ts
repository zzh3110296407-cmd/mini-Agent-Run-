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
      blocked: ['better-sqlite3', 'fastify', 'openai', '../db/smoke.js', '../config/env.js'],
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
