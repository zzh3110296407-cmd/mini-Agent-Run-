import { APP_NAME, HealthResponseSchema } from '@mini-agent-run/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_ALLOWED_TRACE_ROOTS, parseEnv, splitAllowedTraceRoots } from '../src/config/env.js';
import { checkSqliteSmoke } from '../src/db/smoke.js';

describe('M0 SQLite and health probes', () => {
  it('runs SELECT 1 against an in-memory SQLite database', () => {
    expect(checkSqliteSmoke()).toBe(true);
  });

  it('returns a shared health response with a SQLite success marker', async () => {
    const app = buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });

      expect(response.statusCode).toBe(200);
      const health = HealthResponseSchema.parse(response.json());
      expect(health).toMatchObject({ status: 'ok', service: APP_NAME, sqlite: 'ok' });
      expect(Number.isNaN(Date.parse(health.timestamp))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('M0 environment configuration', () => {
  it('defaults to local mock mode without requiring model credentials', () => {
    expect(parseEnv({})).toEqual({
      PORT: 3001,
      TOOL_MODE: 'mock',
      DB_PATH: './data/agent-run.db',
      ALLOWED_TRACE_ROOTS: DEFAULT_ALLOWED_TRACE_ROOTS,
    });
    expect(DEFAULT_ALLOWED_TRACE_ROOTS).toBe('*');
  });

  it('accepts process-style strings and keeps the supplied model configuration', () => {
    const values = {
      PORT: '65535',
      LLM_BASE_URL: 'https://example.test',
      LLM_MODEL: 'test-model',
      LLM_API_KEY: 'test-key',
      TOOL_MODE: 'live',
      DB_PATH: './data/test.db',
      ALLOWED_TRACE_ROOTS: './data/sample,../Database/new data',
    };
    expect(parseEnv({ ...values, PATH: 'unrelated' })).toEqual({ ...values, PORT: 65535 });
  });

  it('splits and deduplicates trace roots in order while retaining internal spaces', () => {
    expect(splitAllowedTraceRoots(' ./data/fixtures, , ../Database/new data, ./data/fixtures, ./other ,'))
      .toEqual(['./data/fixtures', '../Database/new data', './other']);
  });

  it.each(['', ' , , '])('rejects an empty trace-root list %j', (ALLOWED_TRACE_ROOTS) => {
    expect(() => parseEnv({ ALLOWED_TRACE_ROOTS })).toThrow('must contain at least one non-empty path');
  });

  it.each(['0', '65536', '2.5', '', '0x10', true, null])('rejects the invalid port %s', (PORT) => {
    expect(() => parseEnv({ PORT })).toThrow();
  });

  it('rejects an unsupported tool mode', () => {
    expect(() => parseEnv({ TOOL_MODE: 'unsupported' })).toThrow();
  });

  it('accepts precisely the supported port range across generated inputs', () => {
    const validPort = fc.integer({ min: 1, max: 65535 });
    const invalidPort = fc.oneof(
      fc.integer({ min: -65535, max: 0 }),
      fc.integer({ min: 65536, max: 131072 }),
    );

    fc.assert(
      fc.property(validPort, invalidPort, (valid, invalid) => {
        expect(parseEnv({ PORT: String(valid) }).PORT).toBe(valid);
        expect(() => parseEnv({ PORT: String(invalid) })).toThrow();
      }),
      { numRuns: 100, seed: 20261124 },
    );
  });
});
