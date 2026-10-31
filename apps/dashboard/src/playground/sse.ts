/**
 * The `data:` payloads of a server-sent event stream, in order. Events may arrive split across
 * chunks or several to a chunk; comment lines (`:`) and other fields are ignored. Stopping early
 * (break, or an abort that errors the body) releases the stream.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      // The last part is an unfinished event, unless the stream has ended.
      buffer = done ? '' : (events.pop() ?? '');
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
          .join('\n');
        if (data !== '') yield data;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
