import { LLMProviderError } from './errors.js';

export const aborted = () => new LLMProviderError('LLM_ABORTED', 'The model request was aborted.');

export function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

export async function whileActive<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let abort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(aborted());
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject);
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<void> {
  try {
    await whileActive(reader.cancel().catch(() => {}), signal).catch(() => {});
  } finally {
    reader.releaseLock();
  }
}
