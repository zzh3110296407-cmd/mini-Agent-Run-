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

export function openAbortableReader(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  ensureActive(signal);
  const reader = stream.getReader();
  let closing: Promise<void> | undefined;

  function close() {
    if (!closing) {
      signal?.removeEventListener('abort', onAbort);
      const cancel = reader.cancel().catch(() => {});
      reader.releaseLock();
      closing = whileActive(cancel, signal).catch(() => {});
    }
    return closing;
  }

  function onAbort() {
    void close();
  }

  // An async generator can be suspended at a yield when the signal fires.
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return { reader, close };
}
