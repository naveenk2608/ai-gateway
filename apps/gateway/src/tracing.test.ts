import type { Redis } from '@ai-gateway/shared/node';
import { initInMemoryTracing, shutdownTracing } from '@ai-gateway/shared/node';
import { systemClock } from '@ai-gateway/shared';
import { IngestTrace } from '@ai-gateway/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  testAdmission,
  testRouting,
} from '../test/helpers.js';
import { buildApp } from './app.js';
import { ResponseCache } from './cache/response-cache.js';
import { parseModelsConfig } from './models-config.js';
import { createRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';

// OpenTelemetry tracing (M17, ADR 037) with an in-memory exporter: a request, its provider
// attempt, its cache lookup and the worker's ingest form one trace, with the gateway's own IDs.
let tracing: Awaited<ReturnType<typeof initInMemoryTracing>>;

beforeAll(async () => {
  tracing = await initInMemoryTracing('ai-gateway-test');
});

afterAll(async () => {
  await shutdownTracing();
});

function setup() {
  const { logger } = captureLogger();
  const models = parseModelsConfig(
    {
      deployments: { quick: { provider: 'mock', mock: { completionTokens: 3 } } },
      models: { 'mock-1': { deployment: 'quick' } },
    },
    'tracing-test',
  );
  const registry = createRegistry(models, {
    clock: systemClock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization } = inMemoryVerifier(systemClock);
  const events = new RecordingBus();
  const values = new Map<string, string>();
  const redis = {
    get: (k: string) => Promise.resolve(values.get(k) ?? null),
    set: (k: string, v: string) => {
      values.set(k, v);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
  registerChatCompletions(app, {
    registry,
    clock: systemClock,
    verifier,
    events,
    admission: testAdmission(systemClock, logger),
    routing: testRouting(registry, systemClock),
    cache: new ResponseCache({ redis, logger, ttlSeconds: 60, maxEntryBytes: 100_000 }),
  });
  return { app, authorization, events, logger };
}

const CALLER_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const CALLER_SPAN = '00f067aa0ba902b7';
const PROMPT = 'Summarise the quarterly report for Ravi';

describe('tracing', () => {
  it('exports the request, its attempt, the cache lookup and the worker ingest as one trace', async () => {
    const { app, authorization, events, logger } = setup();
    tracing.reset();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization, traceparent: `00-${CALLER_TRACE}-${CALLER_SPAN}-01` },
      payload: { model: 'mock-1', temperature: 0, messages: [{ role: 'user', content: PROMPT }] },
    });
    expect(res.statusCode).toBe(200);
    // The response names the request's span, which the exported span has as its ID.
    const [, traceId, requestSpan, flags] = (res.headers.traceparent as string).split('-');
    expect([traceId, flags]).toEqual([CALLER_TRACE, '01']);

    // The worker stores the request's usage event in a child span of the request.
    new IngestTrace([events.events.at(-1)!]).stored(logger);

    const spans = tracing.spans();
    const byName = (name: string) => spans.filter((s) => s.name === name);
    const [request] = byName('POST /v1/chat/completions');
    expect(request).toMatchObject({
      traceId: CALLER_TRACE,
      spanId: requestSpan,
      parentSpanId: CALLER_SPAN,
      kind: 'server',
      failed: false,
    });
    expect(request!.attributes['http.response.status_code']).toBe(200);
    const attempts = byName('provider.attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      traceId: CALLER_TRACE,
      parentSpanId: requestSpan,
      kind: 'client',
      attributes: {
        'gateway.deployment': 'quick',
        'gateway.provider': 'mock',
        'gateway.outcome': 'success',
        'gateway.attempt': 1,
      },
    });
    expect(byName('cache.lookup')).toEqual([
      expect.objectContaining({
        parentSpanId: requestSpan,
        attributes: { 'gateway.cache_hit': false },
      }),
    ]);
    expect(byName('usage.ingest')).toEqual([
      expect.objectContaining({
        traceId: CALLER_TRACE,
        parentSpanId: requestSpan,
        kind: 'consumer',
      }),
    ]);
    // Never the prompt or the answer.
    expect(JSON.stringify(spans)).not.toContain('quarterly');
  });

  it('starts a trace for a request without traceparent, and marks a failed attempt', async () => {
    const { app, authorization } = setup();
    tracing.reset();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization },
      payload: { model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    const [request] = tracing.spans().filter((s) => s.name === 'POST /v1/chat/completions');
    expect(request).toMatchObject({ parentSpanId: null, failed: false });
    expect(request!.attributes['http.response.status_code']).toBe(404);
    // Health checks are not traced.
    tracing.reset();
    await app.inject({ method: 'GET', url: '/health' });
    expect(tracing.spans()).toEqual([]);
  });
});
