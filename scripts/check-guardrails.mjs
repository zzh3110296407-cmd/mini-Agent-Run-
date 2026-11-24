import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { ENV_EXAMPLE, ENV_SCHEMA, isScannablePath, normalizePath, scanGuardrails } from './lib/guardrails.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const explicitPaths = [ENV_EXAMPLE, '.npmrc', 'docs/feature-graph.json', 'scripts/guardrail-waivers.json',
  'pnpm-lock.yaml', 'yarn.lock', '.husky'];

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function gitPaths(...args) {
  return git(...args, '-z', '--').split('\0').filter(Boolean).map(normalizePath);
}

function canRead(file) {
  const name = basename(file).toLowerCase();
  return isScannablePath(file) && (!/^\.env(?:\.|$)/.test(name) || name === '.env.example');
}

async function loadEnvKeys(file) {
  try {
    const { ENV_KEYS } = await tsImport(pathToFileURL(file).href, import.meta.url);
    if (Array.isArray(ENV_KEYS) && ENV_KEYS.every((key) => typeof key === 'string')) return ENV_KEYS;
  } catch {
    // Report the schema path without including the source or any values it contains.
  }
}

async function loadSnapshotEnvKeys(source) {
  const parent = realpathSync(join(root, 'node_modules'));
  const directory = mkdtempSync(join(parent, '.m0-env-'));
  if (dirname(directory) !== parent) throw new Error('Unexpected schema snapshot directory.');
  const file = join(directory, 'env.mts');

  try {
    writeFileSync(file, source);
    return await loadEnvKeys(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readIndexEnv(trackedPaths, files, envKeys) {
  const tracked = (file) => trackedPaths.has(file);
  if (!tracked(ENV_EXAMPLE) && !tracked(ENV_SCHEMA)) {
    const deleted = gitPaths('diff', '--cached', '--diff-filter=D', '--name-only');
    if (!deleted.includes(ENV_EXAMPLE) && !deleted.includes(ENV_SCHEMA)) return;
  }

  const template = tracked(ENV_EXAMPLE) ? git('show', ':' + ENV_EXAMPLE) : undefined;
  const schema = tracked(ENV_SCHEMA) ? git('show', ':' + ENV_SCHEMA) : undefined;
  let keys;
  if (schema !== undefined) {
    keys = schema === files.get(ENV_SCHEMA) ? envKeys : await loadSnapshotEnvKeys(schema);
  }

  return { template, keys };
}

export async function runGuardrails() {
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

  const envKeys = files.has(ENV_SCHEMA) ? await loadEnvKeys(join(root, ENV_SCHEMA)) : undefined;
  const indexEnv = await readIndexEnv(trackedSet, files, envKeys);
  return scanGuardrails({ envKeys, files, trackedPaths, indexFiles, presentPaths, indexEnv });
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
