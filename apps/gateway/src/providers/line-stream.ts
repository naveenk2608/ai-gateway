import { ProviderError } from './errors.js';

/** Upstream lines longer than this are treated as a broken response rather than buffered forever. */
export const MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Splits a byte stream into lines on `\n`, `\r\n` or `\r`, wherever chunk boundaries fall. A final
 * line without a newline is still yielded.
 */
export async function* splitLines(
  body: AsyncIterable<Uint8Array | string>,
  maxLineLength = MAX_LINE_LENGTH,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char !== '\n' && char !== '\r') continue;
      // A trailing \r may be the first half of \r\n; wait for the next chunk to decide.
      if (char === '\r' && i === buffer.length - 1) break;
      yield buffer.slice(start, i);
      if (char === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > maxLineLength) {
      throw new ProviderError('invalid_response', 'upstream sent an oversized line');
    }
  }
  buffer += decoder.decode();
  if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
  if (buffer !== '') yield buffer;
}

export interface SseEvent {
  event: string | undefined;
  data: string;
}

/**
 * Server-sent events (the subset upstreams use): `data:` lines joined with `\n`, `event:` names,
 * `:` comments ignored, an event dispatched on a blank line. A last event missing its blank line
 * is still dispatched.
 */
export async function* parseSse(
  body: AsyncIterable<Uint8Array | string>,
  maxLineLength = MAX_LINE_LENGTH,
): AsyncGenerator<SseEvent> {
  let data: string[] = [];
  let event: string | undefined;
  for await (const line of splitLines(body, maxLineLength)) {
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      data = [];
      event = undefined;
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length > 0) yield { event, data: data.join('\n') };
}
