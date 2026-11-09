import type { FastifyReply } from 'fastify';
import type { AttemptContext } from './attempt.js';

/** The deployment that answered a /v1 chat completion (not set for cache hits). */
export const DEPLOYMENT_HEADER = 'x-gateway-deployment';
/** Deployments passed over before the one that answered (failed, or circuit open), in order. */
export const FALLBACK_HEADER = 'x-gateway-fallback-from';

/** Tells the client which deployment answered and, after a fallback, which ones it replaced. */
export function routingHeaders(reply: FastifyReply, served: AttemptContext | undefined): void {
  if (!served) return;
  void reply.header(DEPLOYMENT_HEADER, served.deployment.id);
  if (served.passedOver && served.passedOver.length > 0) {
    void reply.header(FALLBACK_HEADER, served.passedOver.join(', '));
  }
}

/** The routing headers a replay repeats (ADR 032): which deployment answered, and fallbacks. */
export function replayHeaders(reply: FastifyReply): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of [DEPLOYMENT_HEADER, FALLBACK_HEADER]) {
    const value = reply.getHeader(name);
    if (typeof value === 'string') kept[name] = value;
  }
  return kept;
}
