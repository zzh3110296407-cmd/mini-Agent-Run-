import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { tsImport } from 'tsx/esm/api';

export async function runLlmSmoke(root, buildPackages) {
  const notConfigured = { ok: false, error: 'LLM_NOT_CONFIGURED' };
  const envPath = join(root, '.env');
  const { parseEnv } = await tsImport('../../apps/server/src/config/env.ts', import.meta.url);
  let env;
  try {
    if (existsSync(envPath) && config({ path: envPath, quiet: true }).error) return notConfigured;
    env = parseEnv(process.env);
  } catch {
    return notConfigured;
  }
  const key = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!key || key === 'your_api_key_here' || !env.LLM_BASE_URL || !model) return notConfigured;

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
