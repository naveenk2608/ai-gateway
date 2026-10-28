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
