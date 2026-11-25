export type LLMErrorCode =
  | 'LLM_ABORTED' | 'LLM_TIMEOUT' | 'LLM_AUTH_ERROR' | 'LLM_RATE_LIMITED' | 'LLM_BAD_REQUEST'
  | 'LLM_UPSTREAM_ERROR' | 'LLM_NETWORK_ERROR' | 'LLM_PROTOCOL_ERROR' | 'LLM_INVALID_TOOL_ARGUMENTS';

export class LLMProviderError extends Error {
  constructor(readonly code: LLMErrorCode, message: string, readonly statusCode?: number) {
    super(redactSecret(message));
    this.name = 'LLMProviderError';
  }
}

export function redactSecret(text: string, secret?: string): string {
  const scrubbed = text.replace(/\bBearer[ \t]+[^\s"'\]};,]+/gi, '[REDACTED]');
  return secret ? scrubbed.split(secret).join('[REDACTED]') : scrubbed;
}
