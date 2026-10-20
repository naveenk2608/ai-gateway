import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { collectDefaultMetrics, Registry } from 'prom-client';

export { Registry } from 'prom-client';

/** A process's metrics registry (ADR 017), with prom-client's default Node process metrics. */
export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return registry;
}

const BEARER = /^Bearer +(\S+) *$/i;
const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Whether an Authorization header is `Bearer <token>`. Compares SHA-256 digests in constant time,
 * so response timing reveals neither the token nor its length.
 */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header === undefined ? null : BEARER.exec(header)?.[1];
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(token));
}

export interface MetricsServerOptions {
  registry: Registry;
  host: string;
  port: number;
  /** When set, scrapes must send `Authorization: Bearer <token>`. */
  token?: string;
  logger: Logger;
}

export interface MetricsServer {
  /** The bound port (useful when `port` was 0). */
  port: number;
  close(): Promise<void>;
}

/**
 * A listener that serves only `GET /metrics`, for the worker and for the gateway's optional
 * private metrics port. It is kept off the public internet by its bind address; the token is an
 * extra check.
 */
export async function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer> {
  const { registry, token, logger } = options;
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain' }).end();
      return;
    }
    if (token !== undefined && !bearerMatches(req.headers.authorization, token)) {
      res
        .writeHead(401, {
          'www-authenticate': 'Bearer realm="metrics"',
          'content-type': 'text/plain',
        })
        .end('unauthorized\n');
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body),
      (err: unknown) => {
        logger.error({ err }, 'collecting metrics failed');
        res.writeHead(500, { 'content-type': 'text/plain' }).end('metrics unavailable\n');
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  logger.info({ host: options.host, port, token: token !== undefined }, 'metrics listener started');
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
