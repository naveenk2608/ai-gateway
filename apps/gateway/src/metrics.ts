import type { Registry } from '@ai-gateway/shared/node';
import { Histogram } from 'prom-client';

/**
 * The gateway's Prometheus metrics (ADR 017). Label values come only from fixed sets or from
 * config (deployments, models), never from request IDs, key IDs or anything a client sends, so
 * the number of series stays bounded however much traffic arrives.
 */

/** Methods Fastify routes; anything else is labelled `other`. */
const METHODS: ReadonlySet<string> = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);

/** Seconds: fast admin reads up to long streams. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

/** The value itself when it is in the allowed set, `other` otherwise. */
export function bounded(value: string | null | undefined, allowed: ReadonlySet<string>): string {
  return value != null && allowed.has(value) ? value : 'other';
}

export class GatewayMetrics {
  readonly registry: Registry;
  readonly #httpDuration: Histogram<'method' | 'route' | 'status_code'>;

  constructor(registry: Registry) {
    this.registry = registry;
    const registers = [registry];
    this.#httpDuration = new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'HTTP requests by method, route pattern and status, until the response ended (streams included). The _count series is the request count.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_BUCKETS,
      registers,
    });
  }

  /** `route` is the matched route pattern (never the raw URL); undefined for unmatched URLs. */
  httpRequest(method: string, route: string | undefined, statusCode: number, seconds: number) {
    this.#httpDuration.observe(
      {
        method: bounded(method, METHODS),
        route: route ?? 'unmatched',
        status_code: String(statusCode),
      },
      seconds,
    );
  }
}
