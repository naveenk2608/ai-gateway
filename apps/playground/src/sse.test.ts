import { describe, expect, it } from 'vitest';
import { sseData } from './sse.js';

/** A body that delivers the given pieces as separate chunks. */
function body(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of sseData(stream)) out.push(data);
  return out;
}

describe('sseData', () => {
  it('yields each event, including ones split across chunks', async () => {
    expect(await all(body('data: {"a":1}\n\ndata: {"b"', ':2}\n\n', 'data: [DONE]\n\n'))).toEqual([
      '{"a":1}',
      '{"b":2}',
      '[DONE]',
    ]);
  });

  it('accepts CRLF line endings, joins multi-line data and skips comments', async () => {
    expect(await all(body(': keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\n'))).toEqual([
      'one\ntwo',
    ]);
  });

  it('keeps multi-byte characters split between chunks intact', async () => {
    const bytes = new TextEncoder().encode('data: héllo ✓\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    expect(await all(stream)).toEqual(['héllo ✓']);
  });

  it('yields a last event that has no blank line after it', async () => {
    expect(await all(body('data: last'))).toEqual(['last']);
  });
});
