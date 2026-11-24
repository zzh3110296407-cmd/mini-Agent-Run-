import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run the CLI contract tests through npm.');

const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => name.toLowerCase() !== 'npm_config_loglevel'));

function invoke(command: string, ...flags: string[]) {
  return spawnSync(process.execPath, [npm, 'run', 'cli', '--', command, ...flags], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function repoStatus() {
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  expect(status.status).toBe(0);
  return status.stdout;
}

describe('M0-06 npm CLI contract', () => {
  it.each(['env-check', 'guardrails', 'smoke'])(
    'emits parseable stdout on both npm invocations of %s',
    (command) => {
      const before = repoStatus();
      const outputs = Array.from({ length: 2 }, () => {
        const result = invoke(command, '--json');
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ ok: true });
        if (command === 'smoke') {
          expect(output).toMatchObject({ statusCode: 200, health: { sqlite: 'ok' } });
          expect(Date.parse(output.health.timestamp)).not.toBeNaN();
          return { ...output, health: { ...output.health, timestamp: null } };
        }
        return output;
      });
      expect(outputs[0]).toEqual(outputs[1]);
      expect(repoStatus()).toBe(before);
    },
    12000,
  );

  it('reports usage on stderr with a nonzero exit for an unknown command', () => {
    const result = invoke('unknown-cmd');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });
});
