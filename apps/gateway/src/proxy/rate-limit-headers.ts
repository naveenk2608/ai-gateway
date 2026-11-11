import type { FastifyReply } from 'fastify';
import type { BucketState, RateLimitState } from '../limits/limiter.js';

/** Seconds with up to three decimals and no trailing zeros: 1.5, 12, 0.25. */
function seconds(ms: number): string {
  return String(Math.round(ms) / 1000);
}

/**
 * A wait in the format OpenAI uses for `x-ratelimit-reset-*`: `120ms`, `1.5s`, `6m0s`, `1h2m3s`.
 */
export function formatReset(ms: number): string {
  const total = Math.max(0, Math.ceil(ms));
  if (total < 1000) return `${total}ms`;
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const rest = seconds(total % 60_000);
  if (hours > 0) return `${hours}h${minutes}m${rest}s`;
  if (minutes > 0) return `${minutes}m${rest}s`;
  return `${rest}s`;
}

/** The OpenAI-style rate-limit headers, per bucket kind: what is allowed, left, and when full. */
export const RATE_LIMIT_HEADERS = {
  requests: {
    limit: 'x-ratelimit-limit-requests',
    remaining: 'x-ratelimit-remaining-requests',
    reset: 'x-ratelimit-reset-requests',
  },
  tokens: {
    limit: 'x-ratelimit-limit-tokens',
    remaining: 'x-ratelimit-remaining-tokens',
    reset: 'x-ratelimit-reset-tokens',
  },
} as const;

/** Every header name `setRateLimitHeaders` may set (CORS exposes them, ADR 021). */
export const RATE_LIMIT_HEADER_NAMES: readonly string[] = Object.values(RATE_LIMIT_HEADERS).flatMap(
  (names) => Object.values(names),
);

function setBucket(reply: FastifyReply, kind: 'requests' | 'tokens', bucket: BucketState): void {
  const names = RATE_LIMIT_HEADERS[kind];
  void reply
    .header(names.limit, String(bucket.limit))
    .header(names.remaining, String(bucket.remaining))
    .header(names.reset, formatReset(bucket.resetMs));
}

/**
 * OpenAI-style rate-limit headers on a successful reply (M12), from the tightest key or project
 * bucket that admission took from: requests (RPM) and tokens (TPM, counted as reserved: the
 * prompt estimate plus the output cap). A kind with no limit set gets no headers.
 */
export function setRateLimitHeaders(reply: FastifyReply, state: RateLimitState | undefined): void {
  if (state?.requests) setBucket(reply, 'requests', state.requests);
  if (state?.tokens) setBucket(reply, 'tokens', state.tokens);
}
