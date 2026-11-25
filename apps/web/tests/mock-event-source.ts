import type { RunEventEnvelope } from '@mini-agent-run/shared';
import type { RunEventSource } from '../src/composables/useRunStream';

export class MockEventSource implements RunEventSource {
  readonly listeners = new Map<string, EventListener>();
  onerror: EventListener | null = null;
  closeCount = 0;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, listener);
  }

  close() { this.closeCount++; }

  emit(envelope: RunEventEnvelope) {
    this.emitRaw(envelope.event.type, JSON.stringify(envelope));
  }

  emitRaw(type: string, data: string) {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }

  fail() { this.onerror?.(new Event('error')); }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
