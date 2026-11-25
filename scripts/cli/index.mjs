import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const usage = 'Usage: npm run cli -- <env-check|guardrails|smoke|graph|tools-smoke|llm-smoke|e2e-smoke> [--path <dir>] [--json|--help]';
const loadGuardrails = () => import('../check-guardrails.mjs');

function envCheck() {
  const exists = (file) => existsSync(join(root, file));
  const checks = [
    { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, value: process.version },
    { name: 'package-lock.json', ok: exists('package-lock.json') },
    { name: 'pnpm-lock.yaml absent', ok: !exists('pnpm-lock.yaml') },
    { name: '.env.example', ok: exists('.env.example') },
  ];
  const warnings = exists('.env') ? [] : ['.env is absent. Local health checks use defaults.'];

  return { ok: checks.every((check) => check.ok), checks, warnings };
}

function buildPackages() {
  // Build the workspace exports so this also works immediately after a fresh install.
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-b', 'tsconfig.packages.json'], {
    cwd: root,
    stdio: 'pipe',
    windowsHide: true,
  });
}

async function smoke() {
  buildPackages();
  const { tsImport } = await import('tsx/esm/api');
  const { buildApp } = await tsImport('../../apps/server/src/app.ts', import.meta.url);
  const { HealthResponseSchema } = await import('@mini-agent-run/shared');
  const app = buildApp();

  try {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    if (response.statusCode !== 200) {
      throw new Error('Health probe returned HTTP ' + response.statusCode + '.');
    }

    const health = HealthResponseSchema.parse(response.json());
    return { ok: true, statusCode: response.statusCode, health };
  } finally {
    await app.close();
  }
}

async function toolsSmoke(path) {
  buildPackages();
  const { runToolsSmoke } = await import('./tools-smoke.mjs');
  return runToolsSmoke(root, path);
}

async function llmSmoke() {
  const { runLlmSmoke } = await import('./llm-smoke.mjs');
  return runLlmSmoke(root, buildPackages);
}

async function e2eSmoke(_path, startServer) {
  if (!startServer) buildPackages();
  const { runE2eSmoke } = await import('./e2e-smoke.mjs');
  return runE2eSmoke(root, { startServer });
}

const commands = new Map([
  ['env-check', envCheck],
  ['guardrails', async () => (await loadGuardrails()).runGuardrails()],
  ['smoke', smoke],
  ['graph', async () => (await loadGuardrails()).runGraph()],
  ['tools-smoke', toolsSmoke],
  ['llm-smoke', llmSmoke],
  ['e2e-smoke', e2eSmoke],
]);

async function printGraph(result) {
  if (!result.present) {
    console.log('SKIP Feature Graph is absent.');
    return;
  }

  if (result.activeMilestone) console.log('Active milestone: ' + result.activeMilestone);
  for (const { id, required, covered, testFiles } of result.nodes) {
    let status = 'DEFERRED';
    if (required) status = covered ? 'COVERED' : 'MISSING';
    const locations = testFiles.length ? ' — ' + testFiles.join(', ') : '';
    console.log('[' + status + '] ' + id + locations);
  }
  const { total, required, covered, missing, deferred } = result.summary;
  console.log('Feature Graph: ' + total + ' total, ' + required + ' required, ' + covered
    + ' covered, ' + missing + ' missing, ' + deferred + ' deferred.');
  if (!result.ok) {
    const { printGuardrails } = await loadGuardrails();
    printGuardrails({ ...result, skipped: [] }, false);
  }
}

async function printResult(command, result, json) {
  if (command === 'guardrails') {
    const { printGuardrails } = await loadGuardrails();
    printGuardrails(result, json);
  } else if (json) {
    console.log(JSON.stringify(result));
  } else if (command === 'graph') {
    await printGraph(result);
  } else if (command === 'env-check') {
    for (const { name, ok, value } of result.checks) {
      console.log((ok ? 'PASS ' : 'FAIL ') + name + (value ? ' ' + value : ''));
    }
    for (const warning of result.warnings) console.warn('WARN ' + warning);
  } else if (command === 'tools-smoke') {
    console.log('PASS tools-smoke | ' + result.artifactSource + ' | '
      + result.rawBytes + ' raw bytes | ' + result.summaryBytes + ' summary bytes | cascade cleared');
  } else if (command === 'llm-smoke') {
    if (result.ok) console.log('PASS llm-smoke | ' + result.provider + ' | ' + result.model + ' | ' + result.reply);
    else console.error(result.error);
  } else if (command === 'e2e-smoke') {
    console.log('PASS e2e-smoke | ' + result.completedRounds + ' completed rounds | ' + result.artifactBytes +
      ' Artifact bytes | stop, retry, restart and cascade verified');
  } else {
    console.log('PASS GET /api/health HTTP ' + result.statusCode + ' | SQLite ' + result.health.sqlite);
  }
}

function parseFlags(command, flags) {
  let path;
  let format;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (command === 'tools-smoke' && flag === '--path' && path === undefined) {
      path = flags[++index];
      if (!path?.trim() || path.startsWith('-')) return null;
    } else if ((flag === '--json' || flag === '--help') && format === undefined) {
      format = flag;
    } else {
      return null;
    }
  }
  return { path, format };
}

export async function runCli([command, ...flags], { startServer } = {}) {
  const run = commands.get(command);
  const options = run ? parseFlags(command, flags) : null;
  if ((command === '--help' && flags.length === 0) || options?.format === '--help') {
    console.log(usage);
    return 0;
  }
  if (!run || !options) {
    console.error(usage);
    return 1;
  }
  const json = options.format === '--json';

  try {
    const result = await run(options.path, startServer);
    await printResult(command, result, json);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (json) {
      const failure = JSON.stringify({ ok: false, error: error.message });
      if (command === 'tools-smoke') console.error(failure);
      else console.log(failure);
    } else {
      console.error(error.message);
    }
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
