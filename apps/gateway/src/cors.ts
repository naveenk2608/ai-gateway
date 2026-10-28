import type { FastifyInstance } from 'fastify';
import { CACHE_HEADER } from './cache/response-cache.js';
import { DEPLOYMENT_HEADER, FALLBACK_HEADER } from './proxy/routing-headers.js';

/** Response headers a browser page may read: the request ID, how it was routed, when to retry. */
export const EXPOSED_HEADERS = [
  'x-request-id',
  DEPLOYMENT_HEADER,
  FALLBACK_HEADER,
  CACHE_HEADER,
  'retry-after',
];

/** Request headers a page may send: the API key, the JSON body, trace context, cache opt-in. */
const ALLOWED_HEADERS = ['authorization', 'content-type', 'traceparent', CACHE_HEADER];

/** How long a browser may reuse a preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

const isV1 = (url: string) => url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?');

/**
 * CORS for the OpenAI-compatible API only (ADR 021): a page served from one of `origins` may call
 * /v1 with an API key in the Authorization header. No cookie authenticates /v1, so credentials
 * are never allowed. Every other path (the admin API with its session cookie, /health, /docs) gets
 * no CORS headers, so browsers keep it same-origin. With no origins, nothing is registered.
 */
export function registerV1Cors(app: FastifyInstance, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  const allowedOrigin = (origin: string | undefined) =>
    origin !== undefined && allowed.has(origin) ? origin : undefined;

  app.addHook('onSend', async (request, reply) => {
    if (!isV1(request.url)) return;
    // The answer differs by Origin, so caches must not share it between origins.
    const vary = reply.getHeader('vary');
    void reply.header('vary', vary ? `${String(vary)}, Origin` : 'Origin');
    const origin = allowedOrigin(request.headers.origin);
    if (!origin) return;
    void reply.header('access-control-allow-origin', origin);
    void reply.header('access-control-expose-headers', EXPOSED_HEADERS.join(', '));
  });

  // Preflight for cross-origin POSTs with an Authorization header; no API key is needed for it.
  app.options('/v1/*', { schema: { hide: true } }, async (request, reply) => {
    if (allowedOrigin(request.headers.origin)) {
      void reply.header('access-control-allow-methods', 'GET, POST');
      void reply.header('access-control-allow-headers', ALLOWED_HEADERS.join(', '));
      void reply.header('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS));
    }
    return reply.code(204).send();
  });
}
