import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { isScannablePath, normalizePath, scanGuardrails } from './lib/guardrails.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const explicitPaths = ['.env.example', 'docs/feature-graph.json', 'scripts/guardrail-waivers.json',
  'pnpm-lock.yaml', 'yarn.lock', '.husky'];

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

function gitPaths(...args) {
  return git(...args, '-z', '--').split('\0').filter(Boolean).map(normalizePath);
}

function canRead(file) {
  const name = basename(file).toLowerCase();
  return isScannablePath(file) && (!/^\.env(?:\.|$)/.test(name) || name === '.env.example');
}

export async function runGuardrails() {
  const { ENV_KEYS } = await tsImport('../apps/server/src/config/env.ts', import.meta.url);
  const trackedPaths = gitPaths('ls-files', '--cached');
  const untrackedPaths = gitPaths('ls-files', '--others', '--exclude-standard');
  const presentPaths = explicitPaths.filter((file) => existsSync(join(root, file)));
  const files = new Map();

  for (const file of new Set([...trackedPaths, ...untrackedPaths, ...presentPaths])) {
    if (!canRead(file)) continue;
    const absolutePath = join(root, file);
    if (lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
      files.set(file, readFileSync(absolutePath, 'utf8'));
    }
  }

  const trackedSet = new Set(trackedPaths);
  const indexFiles = new Map();
  for (const file of gitPaths('diff', '--no-ext-diff', '--name-only')) {
    if (trackedSet.has(file) && canRead(file)) {
      indexFiles.set(file, git('show', ':' + file));
    }
  }

  return scanGuardrails({ envKeys: ENV_KEYS, files, trackedPaths, indexFiles, presentPaths });
}

export function printGuardrails(result, json) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  for (const rule of result.skipped) console.log(rule + ' SKIP — Feature Graph is absent.');
  for (const { rule, file, line, message, snapshot } of result.violations) {
    const location = file + ':' + line + (snapshot === 'index' ? ' (Git index)' : '');
    console.error(location + ' [' + rule + '] ' + message);
  }
  if (result.ok) console.log('Repository guardrails passed.');
}

async function main(args) {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length !== 0 && !json) {
    console.error('Usage: node scripts/check-guardrails.mjs [--json]');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runGuardrails();
    printGuardrails(result, json);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    } else {
      console.error('Unable to run repository guardrails:', error.message);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
