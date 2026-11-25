import { ensureActive, openAbortableReader, whileActive } from './abort.js';

export async function* parseSseByteStream(
  stream: ReadableStream<Uint8Array>, signal?: AbortSignal,
): AsyncGenerator<string> {
  const { reader, close } = openAbortableReader(stream, signal);
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let data: string[] = [];

  function consume(line: string) {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (value === '') {
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (value.startsWith('data:')) {
      const start = value.startsWith('data: ') ? 6 : 5;
      data.push(value.slice(start));
    }
  }

  try {
    for (;;) {
      ensureActive(signal);
      const chunk = await whileActive(reader.read(), signal);
      ensureActive(signal);
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
        const event = consume(pending.slice(start, end));
        start = end + 1;
        if (event) {
          ensureActive(signal);
          yield event;
        }
      }
      pending = pending.slice(start);
      if (chunk.done) {
        const tail = (pending ? consume(pending) : undefined) ?? data.join('\n');
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    await close();
  }
}
