import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import type { ReadinessCheck } from './health.js';

const ok: ReadinessCheck = () => Promise.resolve();
const failing: ReadinessCheck = () => Promise.reject(new Error('connect ECONNREFUSED redis:6379'));
const hanging: ReadinessCheck = () => new Promise(() => undefined);

function appWith(checks: Record<string, ReadinessCheck>) {
  const { logger, lines } = captureLogger();
  return { app: buildApp({ logger, readiness: { checks, timeoutMs: 50 } }), lines };
}

describe('GET /health', () => {
  it('returns 200 even when dependencies are down', async () => {
    const { app } = appWith({ postgres: failing, redis: failing });
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('returns 200 when every check passes', async () => {
    const { app } = appWith({ postgres: ok, redis: ok });
    const res = await app.inject('/ready');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ready',
      checks: {
        postgres: { status: 'ok', latencyMs: expect.any(Number) as number },
        redis: { status: 'ok', latencyMs: expect.any(Number) as number },
      },
    });
  });

  it('returns 503 naming the failing check, without leaking error details', async () => {
    const { app, lines } = appWith({ postgres: ok, redis: failing });
    const res = await app.inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'not_ready',
      checks: { postgres: { status: 'ok' }, redis: { status: 'fail', reason: 'error' } },
    });
    expect(res.body).not.toContain('ECONNREFUSED');
    const logged = lines.find((l) => l.msg === 'readiness check failed');
    expect(logged).toMatchObject({ check: 'redis', reason: 'error' });
  });

  it('returns 503 with reason timeout when a check hangs', async () => {
    const { app } = appWith({ postgres: hanging, redis: ok });
    const res = await app.inject('/ready');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      checks: { postgres: { status: 'fail', reason: 'timeout' }, redis: { status: 'ok' } },
    });
  });
});
