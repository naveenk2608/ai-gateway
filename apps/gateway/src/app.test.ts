import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import { GatewayError } from './errors.js';

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
        type: 'invalid_request_error',
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
