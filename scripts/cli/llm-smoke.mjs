import { existsSync } from 'node:fs';
import { join } from 'node:path';

function configuredKey(value) {
  const key = value?.trim();
  return key && key !== 'your_api_key_here' ? key : undefined;
}

export async function runLlmSmoke(root, buildPackages) {
  const notConfigured = { ok: false, error: 'LLM_NOT_CONFIGURED' };
  // dotenv leaves an explicitly set shell value in place.
  const inheritedKey = process.env.LLM_API_KEY;
  if (inheritedKey !== undefined && !configuredKey(inheritedKey)) return notConfigured;

  const envPath = join(root, '.env');
  let env;
  let key;
  try {
    if (existsSync(envPath)) {
      const { config } = await import('dotenv');
      if (config({ path: envPath, quiet: true }).error) return notConfigured;
    }
    key = configuredKey(process.env.LLM_API_KEY);
    if (!key) return notConfigured;
    const { tsImport } = await import('tsx/esm/api');
    const { parseEnv } = await tsImport('../../apps/server/src/config/env.ts', import.meta.url);
    env = parseEnv(process.env);
  } catch {
    return notConfigured;
  }
  const model = env.LLM_MODEL?.trim();
  if (!env.LLM_BASE_URL || !model) return notConfigured;

  buildPackages();
  const { createOpenAICompatibleProvider, LLMProviderError, redactSecret } = await import('@mini-agent-run/ai');
  const start = performance.now();
  try {
    const provider = createOpenAICompatibleProvider({
      baseUrl: env.LLM_BASE_URL, apiKey: key, providerName: 'deepseek', timeoutMs: 15_000,
    });
    let reply = '';
    for await (const chunk of provider.stream({ model, messages: [{ role: 'user', content: 'Reply with OK.' }] })) {
      if (chunk.type === 'text_delta') reply += chunk.delta;
      if (reply.length > 4096) return { ok: false, error: 'LLM_PROTOCOL_ERROR' };
    }
    if (!reply.trim()) return { ok: false, error: 'LLM_PROTOCOL_ERROR' };
    return {
      ok: true, provider: redactSecret(provider.name, key), model: redactSecret(model, key),
      reply: redactSecret(reply.trim(), key), durationMs: Math.round(performance.now() - start),
    };
  } catch (error) {
    return { ok: false, error: error instanceof LLMProviderError ? error.code : 'LLM_SMOKE_FAILED' };
  }
}
