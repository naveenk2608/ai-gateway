import type { Clock } from '@ai-gateway/shared';
import { request, type Agent, type Dispatcher } from 'undici';
import { errorForStatus, parseRetryAfter, ProviderError } from './errors.js';

/** Response bodies larger than this are rejected rather than buffered. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Turns a network failure into a ProviderError. When the signal has aborted the error is passed
 * through untouched: the attempt knows whether that was a timeout or a client disconnect.
 */
export function networkError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || err instanceof ProviderError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TIMEOUT_CODES.has(code)) {
    return new ProviderError('timeout', `upstream ${code}`, { cause: err });
  }
  return new ProviderError('connection', 'upstream connection failed', { cause: err });
}

/** Reads a response body as text, failing once it passes `limit` bytes. */
export async function readText(
  body: Dispatcher.ResponseData['body'],
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      body.destroy();
      throw new ProviderError('invalid_response', 'upstream response too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError('invalid_response', 'upstream sent invalid JSON', { cause: err });
  }
}

/**
 * A short identifier from an upstream error body (OpenAI's `error.code`/`error.type`, Ollama's
 * `error` text is not used), kept for logs only. Free-text messages are never kept: they can echo
 * prompt content.
 */
function upstreamCode(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, type } = error as { code?: unknown; type?: unknown };
  const candidate = typeof code === 'string' ? code : typeof type === 'string' ? type : undefined;
  return candidate !== undefined && /^[a-zA-Z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : undefined;
}

export interface PostOptions {
  agent: Agent;
  headers: Record<string, string>;
  signal: AbortSignal;
  clock: Clock;
}

/** POSTs JSON upstream. Resolves with a 200 response; any other outcome throws a ProviderError. */
export async function postJson(
  url: string,
  body: unknown,
  { agent, headers, signal, clock }: PostOptions,
): Promise<Dispatcher.ResponseData> {
  let response: Dispatcher.ResponseData;
  try {
    response = await request(url, {
      method: 'POST',
      dispatcher: agent,
      signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw networkError(err, signal);
  }

  if (response.statusCode === 200) return response;

  let text = '';
  try {
    text = await readText(response.body, MAX_ERROR_BODY_BYTES);
  } catch {
    // The status is what matters; an unreadable error body is ignored.
  }
  const retryAfterMs = parseRetryAfter(response.headers['retry-after'], clock.now());
  const error =
    response.statusCode >= 400
      ? errorForStatus(response.statusCode, retryAfterMs)
      : new ProviderError('invalid_response', `unexpected upstream status ${response.statusCode}`, {
          upstreamStatus: response.statusCode,
        });
  error.upstreamCode = upstreamCode(text);
  throw error;
}
