/**
 * Normalized upstream failures. Adapters translate status codes, network errors and bad payloads
 * into these kinds so the gateway never forwards a provider's own error body to clients.
 */
export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'server_error'
  | 'connection'
  | 'invalid_response'
  | 'bad_request'
  | 'auth'
  | 'not_found'
  | 'canceled';

/** Retrying can help for these (ADR 011); the others fail the same way again. */
const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout',
  'rate_limited',
  'server_error',
  'connection',
]);

export interface ProviderErrorOptions {
  upstreamStatus?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly upstreamStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.upstreamStatus = options.upstreamStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Maps an upstream HTTP error status to a normalized error. */
export function errorForStatus(status: number, retryAfterMs?: number): ProviderError {
  const options = { upstreamStatus: status, retryAfterMs };
  if (status === 429) return new ProviderError('rate_limited', 'upstream rate limited', options);
  if (status === 401 || status === 403) {
    return new ProviderError('auth', 'upstream rejected credentials', options);
  }
  if (status === 404) return new ProviderError('not_found', 'upstream model not found', options);
  if (status === 408) return new ProviderError('timeout', 'upstream request timeout', options);
  if (status >= 500) return new ProviderError('server_error', `upstream status ${status}`, options);
  return new ProviderError('bad_request', `upstream rejected request (${status})`, options);
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number,
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
