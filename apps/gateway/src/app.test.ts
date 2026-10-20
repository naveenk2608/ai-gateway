import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { createMetricsRegistry } from '@ai-gateway/shared/node';
import { buildApp } from './app.js';
import { GatewayError } from './errors.js';
import { GatewayMetrics } from './metrics.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function testApp() {
  const { logger, lines } = captureLogger();
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  return { app, lines };
}

describe('request IDs', () => {
  it('returns a server-generated UUIDv7 in x-request-id, unique per request', async () => {
    const { app } = testApp();
    const first = await app.inject('/health');
    const second = await app.inject('/health');
    expect(first.headers['x-request-id']).toMatch(UUID_V7);
    expect(second.headers['x-request-id']).toMatch(UUID_V7);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('ignores a client-sent x-request-id', async () => {
    const { app } = testApp();
    const res = await app.inject({ url: '/health', headers: { 'x-request-id': 'client-chosen' } });
    expect(res.headers['x-request-id']).not.toBe('client-chosen');
    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });

  it('tags every log line of a request with requestId', async () => {
    const { app, lines } = testApp();
    app.get('/logs', (request) => {
      request.log.info('inside handler');
      return { ok: true };
    });
    const res = await app.inject('/logs');
    const requestId = res.headers['x-request-id'];

    const requestLines = lines.filter((l) => l.requestId === requestId);
    expect(requestLines.map((l) => l.msg)).toEqual([
      'incoming request',
      'inside handler',
      'request completed',
    ]);
    expect(lines.filter((l) => 'reqId' in l)).toHaveLength(0);
  });
});

describe('trace context', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const CALLER = '00f067aa0ba902b7';
  const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;

  it('starts a trace and returns its traceparent; every log line carries the IDs', async () => {
    const { app, lines } = testApp();
    app.get('/logs', (request) => {
      request.log.info('inside handler');
      return { ok: true };
    });
    const res = await app.inject('/logs');
    const [, traceId, spanId] = TRACEPARENT.exec(String(res.headers.traceparent)) ?? [];
    expect(traceId).toBeDefined();
    const requestLines = lines.filter((l) => l.requestId === res.headers['x-request-id']);
    expect(requestLines).toHaveLength(3);
    for (const line of requestLines) {
      expect(line).toMatchObject({ traceId, spanId });
      expect(line).not.toHaveProperty('parentSpanId');
    }
  });

  it('continues a valid incoming traceparent with a span of its own', async () => {
    const { app, lines } = testApp();
    const res = await app.inject({
      url: '/health',
      headers: { traceparent: `00-${TRACE}-${CALLER}-01` },
    });
    const [, traceId, spanId] = TRACEPARENT.exec(String(res.headers.traceparent)) ?? [];
    expect(traceId).toBe(TRACE);
    expect(spanId).not.toBe(CALLER);
    expect(String(res.headers.traceparent)).toMatch(/-01$/);
    const line = lines.find((l) => l.requestId === res.headers['x-request-id']);
    expect(line).toMatchObject({ traceId: TRACE, spanId, parentSpanId: CALLER });
  });

  it('starts a new trace for an invalid traceparent, keeping the server request ID', async () => {
    const { app } = testApp();
    const res = await app.inject({
      url: '/health',
      headers: { traceparent: `00-${'0'.repeat(32)}-${CALLER}-01`, 'x-request-id': 'mine' },
    });
    const [, traceId] = TRACEPARENT.exec(String(res.headers.traceparent)) ?? [];
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });
});

describe('error responses', () => {
  it('answers unknown routes with an OpenAI-style 404', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'POST', url: '/v1/unknown?x=1' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        message: 'Invalid URL (POST /v1/unknown)',
        type: 'invalid_request_error',
        param: null,
        code: 'not_found',
      },
    });
  });

  it('hides unexpected errors behind a generic 500 and logs them', async () => {
    const { app, lines } = testApp();
    app.get('/boom', () => {
      throw new Error('database password is hunter2');
    });
    const res = await app.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        param: null,
        code: 'internal_error',
      },
    });
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('at ');
    const logged = lines.find((l) => l.msg === 'unhandled error');
    expect(logged?.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns a GatewayError with its own status and code', async () => {
    const { app } = testApp();
    app.get('/limited', () => {
      throw new GatewayError('rate_limited', 'Too many requests', { httpStatus: 429 });
    });
    const res = await app.inject('/limited');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: {
        message: 'Too many requests',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limited',
      },
    });
  });

  it('maps malformed JSON to an OpenAI-style 400', async () => {
    const { app } = testApp();
    app.post('/echo', (request) => request.body);
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"model":',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { type: string; code: string } }>();
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toMatch(/^FST_ERR_/);
  });
});

describe('client IP behind proxies (TRUST_PROXY)', () => {
  function ipApp(trustProxy: number) {
    const app = buildApp({
      logger: captureLogger().logger,
      readiness: { checks: {}, timeoutMs: 50 },
      trustProxy,
    });
    app.get('/ip', (request) => ({ ip: request.ip }));
    return app;
  }
  const ip = async (trustProxy: number, forwardedFor: string) =>
    (
      await ipApp(trustProxy).inject({ url: '/ip', headers: { 'x-forwarded-for': forwardedFor } })
    ).json<{ ip: string }>().ip;

  it('uses the TCP peer by default, ignoring X-Forwarded-For', async () => {
    expect(await ip(0, '203.0.113.9')).toBe('127.0.0.1');
  });

  it('takes the entry the trusted proxy added, not one the client wrote', async () => {
    expect(await ip(1, '198.51.100.1, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ip(2, '198.51.100.1, 203.0.113.9, 10.0.0.2')).toBe('203.0.113.9');
  });
});

describe('GET /metrics', () => {
  const TOKEN = 'm'.repeat(40);

  function metricsApp(metricsToken?: string) {
    const { logger } = captureLogger();
    const metrics = new GatewayMetrics(createMetricsRegistry(), { deployments: [], models: [] });
    const app = buildApp({
      logger,
      readiness: { checks: {}, timeoutMs: 50 },
      metrics,
      metricsToken,
    });
    return { app, metrics };
  }

  it('does not exist when no METRICS_TOKEN is set', async () => {
    const { app } = metricsApp();
    const res = await app.inject('/metrics');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('rejects a missing or wrong token with 401 and reveals no metrics', async () => {
    const { app } = metricsApp(TOKEN);
    for (const authorization of [undefined, `Bearer ${'x'.repeat(40)}`, TOKEN, `Basic ${TOKEN}`]) {
      const res = await app.inject({
        url: '/metrics',
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
      expect(res.json()).toMatchObject({ error: { code: 'invalid_metrics_token' } });
      expect(res.body).not.toContain('gateway_');
    }
  });

  it('serves the registry in the Prometheus text format with the token', async () => {
    const { app } = metricsApp(TOKEN);
    await app.inject('/health');
    const res = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(res.body).toContain(
      'gateway_http_request_duration_seconds_count{method="GET",route="/health",status_code="200"} 1',
    );
    expect(res.body).toContain('process_resident_memory_bytes');
  });

  it('labels requests by route pattern, never by the raw URL', async () => {
    const { app, metrics } = metricsApp(TOKEN);
    app.get('/things/:id', () => ({ ok: true }));
    await app.inject('/things/0193b2c4-0000-7000-8000-000000000001');
    await app.inject('/things/another-id');
    await app.inject('/no/such/page?q=secret');
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'gateway_http_request_duration_seconds_count{method="GET",route="/things/:id",status_code="200"} 2',
    );
    expect(text).toContain(
      'gateway_http_request_duration_seconds_count{method="GET",route="unmatched",status_code="404"} 1',
    );
    expect(text).not.toMatch(/another-id|0193b2c4|secret|no\/such/);
  });
});
