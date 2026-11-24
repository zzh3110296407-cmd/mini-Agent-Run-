import { spawnSync } from 'node:child_process';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the verification checks through npm.');

for (const step of ['typecheck', 'lint', 'guardrails', 'test', 'build']) {
  console.log('[verify] ' + step);
  const result = spawnSync(process.execPath, [npm, 'run', step], {
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.status !== 0) {
    const reason = result.error?.message ?? result.signal ?? 'exit ' + result.status;
    console.error('[verify] ' + step + ' failed (' + reason + ').');
    process.exitCode = result.status ?? 1;
    break;
  }
}
