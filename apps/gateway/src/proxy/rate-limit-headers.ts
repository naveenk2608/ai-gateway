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

function setBucket(reply: FastifyReply, kind: 'requests' | 'tokens', bucket: BucketState): void {
  void reply
    .header(`x-ratelimit-limit-${kind}`, String(bucket.limit))
    .header(`x-ratelimit-remaining-${kind}`, String(bucket.remaining))
    .header(`x-ratelimit-reset-${kind}`, formatReset(bucket.resetMs));
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
