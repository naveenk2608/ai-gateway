import { afterEach, describe, expect, it } from 'vitest';
import { Counter } from 'prom-client';
import { createLogger } from './logger.js';
import {
  bearerMatches,
  createMetricsRegistry,
  startMetricsServer,
  type MetricsServer,
} from './metrics.js';

const TOKEN = 'a'.repeat(40);
const logger = createLogger({ name: 'test', level: 'silent' });

describe('bearerMatches', () => {
  it('accepts only the exact token after Bearer', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches('', TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}b`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
  });
});

describe('createMetricsRegistry', () => {
  it('includes the default process metrics', async () => {
    const text = await createMetricsRegistry().metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });
});

describe('startMetricsServer', () => {
  let server: MetricsServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(token?: string) {
    const registry = createMetricsRegistry();
    new Counter({ name: 'test_things_total', help: 'Things.', registers: [registry] }).inc(3);
    server = await startMetricsServer({ registry, host: '127.0.0.1', port: 0, token, logger });
    return `http://127.0.0.1:${server.port}`;
  }

  it('rejects scrapes without the token or with a wrong one', async () => {
    const base = await start(TOKEN);
    const missing = await fetch(`${base}/metrics`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await missing.text()).not.toContain('test_things_total');
    const wrong = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${'b'.repeat(40)}` },
    });
    expect(wrong.status).toBe(401);
  });

  it('serves metrics in the Prometheus text format with the token', async () => {
    const base = await start(TOKEN);
    const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(await res.text()).toContain('test_things_total 3');
  });

  it('serves metrics without a token when none is configured', async () => {
    const base = await start();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
  });

  it('answers only /metrics, and only to GET', async () => {
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(405);
  });
});
