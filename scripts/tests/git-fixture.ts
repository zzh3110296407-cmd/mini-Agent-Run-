import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const envSchema = 'apps/server/src/config/env.ts';
export const envExample = '.env.example';
export const guardrailEntry = 'scripts/check-guardrails.mjs';

export function inGitFixture(test: (cwd: string) => void, extraFiles: string[] = []) {
  const fixtureParent = resolve('node_modules');
  const cwd = mkdtempSync(join(fixtureParent, 'guardrails-fixture-'));
  if (dirname(cwd) !== fixtureParent) throw new Error('Unexpected Git fixture directory.');

  try {
    for (const path of [envSchema, envExample, guardrailEntry, 'scripts/lib/guardrails.mjs', 'package.json', ...extraFiles]) {
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

export function gitIn(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, windowsHide: true });
}
