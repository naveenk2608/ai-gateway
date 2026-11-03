import type { Clock } from '@ai-gateway/shared';
import { request, type Agent, type Dispatcher } from 'undici';
import { errorForStatus, parseRetryAfter, ProviderError } from './errors.js';
import type { RateLimitHeaders } from './types.js';

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

const SHORT_CODE = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Longest excerpt of an upstream error message that is logged. */
export const MAX_UPSTREAM_MESSAGE = 200;
/** Only this much of a message is searched for request text; the rest is cut anyway. */
const SCANNED_MESSAGE = 2 * MAX_UPSTREAM_MESSAGE;
// Any run of 17 or more characters that also appears in the request's text contains one of these
// windows; a window that matches is then widened to the whole run.
const ECHO_WINDOW = 12;
const ECHO_STRIDE = 6;
const KEY_LIKE = [
  /\bBearer\s+\S+/gi,
  // Common key prefixes (OpenAI, OpenRouter, Groq, NVIDIA, xAI) and Google's API keys.
  /\b(?:sk|gsk|nvapi|xai)[-_][\w-]{8,}/g,
  /\bAIza[\w-]{30,}/g,
  // Long unbroken tokens; hyphenated model IDs and UUIDs stay readable.
  /[A-Za-z0-9_]{32,}/g,
];

/**
 * The code and message of an upstream error body, in the shapes providers use: OpenAI's
 * `{ error: { code, type, message } }` (Gemini wraps it in an array, Ollama sends `error` as text),
 * Mistral's top-level `{ code, type, message }` and NVIDIA's `{ status, title, detail }`.
 */
export function upstreamDetail(body: unknown): { code?: string; message?: string } {
  const outer: unknown = Array.isArray(body) ? body[0] : body;
  if (typeof outer !== 'object' || outer === null) return {};
  const { error } = outer as { error?: unknown };
  const inner = (typeof error === 'object' && error !== null ? error : outer) as Record<
    string,
    unknown
  >;
  // A named code beats a numeric one (Gemini: `code: 503`, `status: "UNAVAILABLE"`).
  const fields = [inner.code, inner.type, inner.status];
  const named = fields.find((f): f is string => typeof f === 'string' && SHORT_CODE.test(f));
  const numeric = fields.find((f): f is number => Number.isInteger(f));
  const message = [inner.message, inner.detail, error].find(
    (m): m is string => typeof m === 'string' && m.trim() !== '',
  );
  return {
    ...(named !== undefined || numeric !== undefined ? { code: named ?? String(numeric) } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * What of an upstream error message may be logged: credentials (`secrets`, plus anything shaped
 * like a key) and every stretch of 17 or more characters that repeats the request's own text
 * (`sent`: its prompt and other strings) are replaced, whitespace is collapsed, and the result is
 * cut to MAX_UPSTREAM_MESSAGE characters. Providers echo prompt text in some errors.
 */
export function loggableMessage(
  message: string,
  secrets: readonly string[],
  sent: unknown,
): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  for (const pattern of KEY_LIKE) text = text.replace(pattern, '[redacted]');
  text = withoutRequestText(text.slice(0, SCANNED_MESSAGE), requestStrings(sent));
  return text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, MAX_UPSTREAM_MESSAGE);
}

/** Every string in what was sent upstream except the model name. */
function requestStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= ECHO_WINDOW) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) requestStrings(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'model') requestStrings(item, out);
    }
  }
  return out;
}

function withoutRequestText(text: string, sent: readonly string[]): string {
  if (sent.length === 0) return text;
  const hidden = new Uint8Array(text.length);
  let found = false;
  for (let i = 0; i + ECHO_WINDOW <= text.length; i += ECHO_STRIDE) {
    const window = text.slice(i, i + ECHO_WINDOW);
    for (const s of sent) {
      const at = s.indexOf(window);
      if (at < 0) continue;
      // Widen the match both ways along this occurrence of the window.
      let start = i;
      let from = at;
      while (start > 0 && from > 0 && text[start - 1] === s[from - 1]) {
        start--;
        from--;
      }
      let end = i + ECHO_WINDOW;
      let to = at + ECHO_WINDOW;
      while (end < text.length && to < s.length && text[end] === s[to]) {
        end++;
        to++;
      }
      hidden.fill(1, start, end);
      found = true;
      break;
    }
  }
  if (!found) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (!hidden[i]) out += text[i];
    else if (i === 0 || !hidden[i - 1]) out += '[request text]';
  }
  return out;
}

/**
 * Puts an upstream error body's code and the loggable start of its message on `error`. `secrets`
 * are the credentials sent with the request, `sent` what was sent (see loggableMessage).
 */
export function attachUpstreamDetail(
  error: ProviderError,
  body: unknown,
  secrets: readonly string[],
  sent: unknown,
): ProviderError {
  const { code, message } = upstreamDetail(body);
  error.upstreamCode = code;
  error.upstreamMessage =
    message === undefined ? undefined : loggableMessage(message, secrets, sent);
  return error;
}

/** Header values that carry credentials, also without their `Bearer ` prefix. */
function credentialsIn(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([name, value]) =>
    /authorization|key|token/i.test(name) ? [value, value.replace(/^Bearer\s+/i, '')] : [],
  );
}

function parseQuietly(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * GETs a URL and discards the body: a health probe (ADR 012). Resolves on 2xx; otherwise throws
 * the ProviderError for the status or network failure.
 */
export async function probeGet(
  url: string,
  { agent, headers, signal, clock }: PostOptions,
): Promise<void> {
  let response: Dispatcher.ResponseData;
  try {
    response = await request(url, { method: 'GET', dispatcher: agent, signal, headers });
  } catch (err) {
    throw networkError(err, signal);
  }
  await response.body.dump().catch(() => undefined);
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  throw errorForStatus(
    response.statusCode,
    parseRetryAfter(response.headers['retry-after'], clock.now()),
  );
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
  throw attachUpstreamDetail(error, parseQuietly(text), credentialsIn(headers), body);
}

/** A non-negative integer header, or undefined when absent or not a number. */
function headerCount(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The provider's own request and token counts from `x-ratelimit-limit-*` and
 * `x-ratelimit-remaining-*` headers (sent by Groq and others); undefined when there are none.
 */
export function rateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
): RateLimitHeaders | undefined {
  const found: RateLimitHeaders = {
    limitRequests: headerCount(headers['x-ratelimit-limit-requests']),
    remainingRequests: headerCount(headers['x-ratelimit-remaining-requests']),
    limitTokens: headerCount(headers['x-ratelimit-limit-tokens']),
    remainingTokens: headerCount(headers['x-ratelimit-remaining-tokens']),
  };
  return Object.values(found).some((v) => v !== undefined) ? found : undefined;
}
