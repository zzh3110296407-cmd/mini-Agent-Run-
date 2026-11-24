import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { printGuardrails, runGuardrails } from '../check-guardrails.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const usage = 'Usage: npm run cli -- <env-check|guardrails|smoke> [--json|--help]';

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

async function smoke() {
  // Build the workspace export so this also works immediately after a fresh install.
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/shared/tsconfig.json'], {
    cwd: root,
    stdio: 'pipe',
    windowsHide: true,
  });

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

const commands = new Map([
  ['env-check', envCheck],
  ['guardrails', runGuardrails],
  ['smoke', smoke],
]);

function printResult(command, result, json) {
  if (command === 'guardrails') {
    printGuardrails(result, json);
  } else if (json) {
    console.log(JSON.stringify(result));
  } else if (command === 'env-check') {
    for (const { name, ok, value } of result.checks) {
      console.log((ok ? 'PASS ' : 'FAIL ') + name + (value ? ' ' + value : ''));
    }
    for (const warning of result.warnings) console.warn('WARN ' + warning);
  } else {
    console.log('PASS GET /api/health HTTP ' + result.statusCode + ' | SQLite ' + result.health.sqlite);
  }
}

const [command, ...flags] = process.argv.slice(2);
const run = commands.get(command);
const flag = flags[0];

if ((command === '--help' && flags.length === 0) || (run && flag === '--help' && flags.length === 1)) {
  console.log(usage);
} else if (!run || flags.length > 1 || (flag !== undefined && flag !== '--json')) {
  console.error(usage);
  process.exitCode = 1;
} else {
  const json = flag === '--json';

  try {
    const result = await run();
    printResult(command, result, json);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  }
}
