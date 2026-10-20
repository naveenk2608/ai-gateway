import { describe, expect, it } from 'vitest';
import { parseSse, splitLines } from './line-stream.js';

async function* chunks(...parts: (string | Uint8Array)[]) {
  for (const part of parts) {
    await Promise.resolve(); // each chunk arrives on a later tick, as from a socket
    yield part;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('splitLines', () => {
  it('splits on \\n, \\r\\n and \\r', async () => {
    expect(await collect(splitLines(chunks('a\nb\r\nc\rd')))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles lines and \\r\\n pairs split across chunks', async () => {
    expect(await collect(splitLines(chunks('al', 'pha\r', '\nbe', 'ta\r', '\r\n')))).toEqual([
      'alpha',
      'beta',
      '',
    ]);
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('café\n');
    expect(await collect(splitLines(chunks(bytes.slice(0, 4), bytes.slice(4))))).toEqual(['café']);
  });

  it('rejects an oversized line', async () => {
    await expect(collect(splitLines(chunks('x'.repeat(20)), 10))).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('parseSse', () => {
  it('dispatches events on blank lines, joining multi-line data', async () => {
    const body = 'data: one\n\ndata: two\ndata: lines\n\nevent: ping\ndata: x\n\n';
    expect(await collect(parseSse(chunks(body)))).toEqual([
      { event: undefined, data: 'one' },
      { event: undefined, data: 'two\nlines' },
      { event: 'ping', data: 'x' },
    ]);
  });

  it('ignores comments and events without data', async () => {
    const body = ': keep-alive\n\nevent: empty\n\ndata: real\n\n';
    expect(await collect(parseSse(chunks(body)))).toEqual([{ event: undefined, data: 'real' }]);
  });

  it('produces the same events however the bytes are chunked', async () => {
    const body = 'data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n';
    const whole = await collect(parseSse(chunks(body)));
    const byteByByte = await collect(parseSse(chunks(...body.split(''))));
    expect(byteByByte).toEqual(whole);
    expect(whole.map((e) => e.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('dispatches a final event that is missing its blank line', async () => {
    expect(await collect(parseSse(chunks('data: last')))).toEqual([
      { event: undefined, data: 'last' },
    ]);
  });
});
