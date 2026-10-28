import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import { GatewayError } from './errors.js';

const PLAYGROUND = 'https://playground.example.com';
const OTHER = 'https://evil.example.net';

/** The app with a stand-in /v1 route, a failing one, and an admin route. */
function testApp(allowedOrigins: string[] = [PLAYGROUND]) {
  const { logger } = captureLogger();
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 }, allowedOrigins });
  app.get('/v1/things', () => ({ ok: true }));
  app.post('/v1/limited', () => {
    throw new GatewayError('rpm_limit_exceeded', 'Rate limit reached.', {
      httpStatus: 429,
      retryAfterSeconds: 7,
    });
  });
  app.get('/admin/me', () => ({ ok: true }));
  return app;
}

describe('CORS for /v1', () => {
  it('lets an allowed origin read the response and the routing and request-ID headers', async () => {
    const res = await testApp().inject({ url: '/v1/things', headers: { origin: PLAYGROUND } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(PLAYGROUND);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(res.headers['access-control-expose-headers']).split(', ')).toEqual([
      'x-request-id',
      'x-gateway-deployment',
      'x-gateway-fallback-from',
      'x-gateway-cache',
      'retry-after',
    ]);
    expect(res.headers.vary).toContain('Origin');
  });

  it('sends no CORS headers to an origin that is not listed', async () => {
    const res = await testApp().inject({ url: '/v1/things', headers: { origin: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('adds them to errors too, so a page can read a 429 and its Retry-After', async () => {
    const res = await testApp().inject({
      method: 'POST',
      url: '/v1/limited',
      headers: { origin: PLAYGROUND },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['access-control-allow-origin']).toBe(PLAYGROUND);
    expect(res.headers['retry-after']).toBe('7');
    const missing = await testApp().inject({ url: '/v1/nothing', headers: { origin: PLAYGROUND } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBe(PLAYGROUND);
  });

  it('answers a preflight for an allowed origin with the methods and headers it may use', async () => {
    const res = await testApp().inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: {
        origin: PLAYGROUND,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(PLAYGROUND);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST');
    expect(String(res.headers['access-control-allow-headers'])).toContain('authorization');
    expect(String(res.headers['access-control-allow-headers'])).toContain('content-type');
  });

  it('gives a preflight from another origin nothing to allow', async () => {
    const res = await testApp().inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: { origin: OTHER, 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('keeps the admin API same-origin, even for an allowed origin', async () => {
    const app = testApp();
    const res = await app.inject({ url: '/admin/me', headers: { origin: PLAYGROUND } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/admin/me',
      headers: { origin: PLAYGROUND, 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.statusCode).toBe(404);
  });

  it('allows no other origin at all when ALLOWED_ORIGINS is empty', async () => {
    const app = testApp([]);
    const res = await app.inject({ url: '/v1/things', headers: { origin: PLAYGROUND } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers.vary).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/things',
      headers: { origin: PLAYGROUND, 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(404);
  });
});
