import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import { GatewayError } from './errors.js';
import { setRateLimitHeaders } from './proxy/rate-limit-headers.js';

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
    expect(String(res.headers['access-control-expose-headers']).split(', ')).toEqual(
      expect.arrayContaining([
        'x-request-id',
        'x-gateway-deployment',
        'x-gateway-fallback-from',
        'x-gateway-cache',
        'retry-after',
      ]),
    );
    expect(res.headers.vary).toContain('Origin');
  });

  it('exposes the headers added since M12: replays, similarity, trace and rate limits', async () => {
    const res = await testApp().inject({ url: '/v1/things', headers: { origin: PLAYGROUND } });
    const exposed = String(res.headers['access-control-expose-headers']).split(', ');
    expect(exposed).toEqual(
      expect.arrayContaining([
        'idempotent-replayed',
        'x-gateway-semantic-similarity',
        'traceparent',
        'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-reset-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-tokens',
      ]),
    );
    expect(new Set(exposed).size).toBe(exposed.length);
  });

  it('names in the expose list every rate-limit header a reply carries', async () => {
    const app = testApp();
    app.get('/v1/limits', (_request, reply) => {
      setRateLimitHeaders(reply, {
        requests: { limit: 60, remaining: 59, resetMs: 1000 },
        tokens: { limit: 1000, remaining: 900, resetMs: 6000 },
      });
      return { ok: true };
    });
    const res = await app.inject({ url: '/v1/limits', headers: { origin: PLAYGROUND } });
    const exposed = String(res.headers['access-control-expose-headers']).split(', ');
    const sent = Object.keys(res.headers).filter((name) => name.startsWith('x-ratelimit-'));
    expect(sent).toHaveLength(6);
    expect(exposed).toEqual(expect.arrayContaining(sent));
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

  it('lets a page send Idempotency-Key and the semantic cache header (M15, M18)', async () => {
    const res = await testApp().inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: {
        origin: PLAYGROUND,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'authorization, content-type, idempotency-key, x-gateway-semantic-cache',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers']).split(', ')).toEqual(
      expect.arrayContaining([
        'authorization',
        'content-type',
        'traceparent',
        'x-gateway-cache',
        'idempotency-key',
        'x-gateway-semantic-cache',
      ]),
    );
  });

  it('gives a preflight from another origin nothing to allow', async () => {
    const res = await testApp().inject({
      method: 'OPTIONS',
      url: '/v1/chat/completions',
      headers: {
        origin: OTHER,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'idempotency-key, x-gateway-semantic-cache',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('keeps the admin API same-origin, even for an allowed origin', async () => {
    const app = testApp();
    const res = await app.inject({ url: '/admin/me', headers: { origin: PLAYGROUND } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
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
