/**
 * M8: metrics move with real traffic through the mock provider, /metrics needs the token, and one
 * request can be followed by its trace ID through gateway, attempt and consumer log lines.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig, type LogLine } from './helpers.js';

const tag = randomBytes(3).toString('hex');
const ok = `ok-${tag}`;
const failing = `failing-${tag}`;
const models = parseModelsConfig(
  {
    deployments: {
      [ok]: { provider: 'mock', model: `mock-${tag}`, mock: { completionTokens: 5 } },
      [failing]: { provider: 'mock', model: `mock-${tag}`, mock: { failWith: 500 } },
    },
    models: {
      'mock-ok': { deployment: ok },
      'mock-fallback': {
        policy: 'priority',
        targets: [{ deployment: failing }, { deployment: ok }],
      },
    },
  },
  'observability',
);

const TOKEN = randomBytes(24).toString('hex');
const TRACE = randomBytes(16).toString('hex');
const CALLER_SPAN = randomBytes(8).toString('hex');

let gateway: Gateway;
let url: string;
let key: string;
let limitedKey: string;
let lines: LogLine[];

beforeAll(async () => {
  const captured = captureLogger();
  lines = captured.lines;
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:obs:${tag}`,
      EVENTS_DLQ_STREAM: `test:obs:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `obs-${tag}`,
      WORKER_BLOCK_MS: '100',
      CACHE_ENABLED: 'true',
      RETRY_BASE_DELAY_MS: '0',
      RETRY_MAX_DELAY_MS: '0',
      METRICS_TOKEN: TOKEN,
      METRICS_PORT: '0',
    }),
    captured.logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  key = (await createApiKey(gateway.db, await createProject(gateway.db))).plaintext;
  const limited = await createProject(gateway.db);
  await gateway.db
    .updateTable('projects')
    .set({ rpm_limit: 1 })
    .where('id', '=', limited)
    .execute();
  limitedKey = (await createApiKey(gateway.db, limited)).plaintext;
});

afterAll(async () => {
  await gateway.shutdown();
});

function chat(body: object, apiKey = key, headers: Record<string, string> = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello' }], ...body }),
  });
}

async function scrape(base = url): Promise<string> {
  const res = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return res.text();
}

/** Sum of the samples of `name` whose labels include `labels`. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (match?.[1] !== name) continue;
    const found = new Map(
      [...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!] as const),
    );
    if (Object.entries(labels).every(([k, v]) => found.get(k) === v)) total += Number(match[3]);
  }
  return total;
}

describe('metrics after real requests', () => {
  it('count requests, attempts, routing, cache, rejections and the pipeline', async () => {
    const before = await scrape();
    const route = { method: 'POST', route: '/v1/chat/completions' };

    expect((await chat({ model: 'mock-ok' })).status).toBe(200);
    const streamed = await chat({ model: 'mock-ok', stream: true });
    expect(streamed.status).toBe(200);
    await streamed.text();
    expect((await chat({ model: 'mock-fallback' })).status).toBe(200);
    expect((await chat({ model: 'mock-ok', temperature: 0 })).headers.get('x-gateway-cache')).toBe(
      'miss',
    );
    expect((await chat({ model: 'mock-ok', temperature: 0 })).headers.get('x-gateway-cache')).toBe(
      'hit',
    );
    expect((await chat({ model: 'mock-ok' }, limitedKey)).status).toBe(200);
    expect((await chat({ model: 'mock-ok' }, limitedKey)).status).toBe(429);
    await vi.waitFor(() => expect(gateway.consumer!.stats.processed).toBeGreaterThanOrEqual(7), {
      timeout: 10_000,
    });

    const after = await scrape();
    const moved = (name: string, labels: Record<string, string> = {}) =>
      sample(after, name, labels) - sample(before, name, labels);
    const http = 'gateway_http_request_duration_seconds_count';
    expect(moved(http, { ...route, status_code: '200' })).toBe(6);
    expect(moved(http, { ...route, status_code: '429' })).toBe(1);
    const attempts = 'gateway_upstream_attempts_total';
    expect(moved(attempts, { deployment: ok, outcome: 'success' })).toBe(5);
    expect(moved(attempts, { deployment: failing, outcome: 'server_error' })).toBe(2);
    expect(moved('gateway_retries_total', { deployment: failing })).toBe(1);
    expect(moved('gateway_fallbacks_total', { model: 'mock-fallback' })).toBe(1);
    expect(moved('gateway_cache_lookups_total', { result: 'miss' })).toBe(1);
    expect(moved('gateway_cache_lookups_total', { result: 'hit' })).toBe(1);
    expect(moved('gateway_admission_rejections_total', { reason: 'rpm' })).toBe(1);
    expect(moved('gateway_ttft_seconds_count', { deployment: ok })).toBe(1);
    // Successful calls with reported usage: every 200 except the cache hit.
    expect(moved('gateway_output_tokens_per_second_count', { deployment: ok })).toBe(5);
    expect(moved('gateway_prompt_token_estimate_error_ratio_count', { deployment: ok })).toBe(5);
    expect(moved('gateway_usage_events_published_total')).toBe(7);
    expect(sample(after, 'gateway_usage_events_dropped_total')).toBe(0);
    expect(moved('worker_events_consumed_total')).toBe(7);
    expect(sample(after, 'usage_stream_up')).toBe(1);
    expect(
      sample(after, 'gateway_circuit_breaker_state', { deployment: ok, state: 'closed' }),
    ).toBe(1);
    expect(sample(after, 'gateway_dependency_up', { dependency: 'postgres' })).toBe(1);
    expect(sample(after, 'gateway_dependency_up', { dependency: 'redis' })).toBe(1);
    // Nothing a client sent became a label.
    expect(after).not.toMatch(/Say hello|gw_|[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('rejects scrapes without the token or with a wrong one, on both listeners', async () => {
    const wrong = `Bearer ${randomBytes(24).toString('hex')}`;
    const privateUrl = `http://127.0.0.1:${gateway.metricsPort()}`;
    for (const base of [url, privateUrl]) {
      const missing = await fetch(`${base}/metrics`);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(await missing.text()).not.toContain('gateway_');
      expect((await fetch(`${base}/metrics`, { headers: { authorization: wrong } })).status).toBe(
        401,
      );
    }
    expect(sample(await scrape(privateUrl), 'gateway_upstream_attempts_total')).toBeGreaterThan(0);
  });
});

describe('trace context', () => {
  it('follows one request through gateway, attempt and consumer logs by its trace ID', async () => {
    const res = await chat({ model: 'mock-ok' }, key, {
      traceparent: `00-${TRACE}-${CALLER_SPAN}-01`,
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id');
    const [, traceId, spanId] =
      /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(res.headers.get('traceparent') ?? '') ?? [];
    expect(traceId).toBe(TRACE);

    await vi.waitFor(
      () =>
        expect(lines.some((l) => l.msg === 'usage event stored' && l.traceId === TRACE)).toBe(true),
      { timeout: 10_000 },
    );
    const traced = lines.filter((l) => l.traceId === TRACE);
    const byMessage = (msg: string) => traced.find((l) => l.msg === msg);
    expect(byMessage('incoming request')).toMatchObject({
      requestId,
      spanId,
      parentSpanId: CALLER_SPAN,
    });
    const attempt = byMessage('provider attempt finished');
    expect(attempt).toMatchObject({ requestId, spanId, deployment: ok });
    expect(attempt?.attemptSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(byMessage('request completed')).toMatchObject({ requestId, spanId });
    const stored = byMessage('usage event stored');
    expect(stored).toMatchObject({ requestId, parentSpanId: spanId });
    expect(stored?.spanId).not.toBe(spanId);
    // Every line of the trace belongs to this one request.
    expect(new Set(traced.map((l) => l.requestId))).toEqual(new Set([requestId]));
  });
});

describe('stream lag while no worker consumes', () => {
  it('rises in /metrics and in the infra endpoint the Infrastructure page reads', async () => {
    const lagTag = randomBytes(3).toString('hex');
    // No consumer: the worker is stopped (and none runs in-process).
    const idle = createGateway(
      testConfig({
        EVENTS_STREAM: `test:lag:${lagTag}`,
        EVENTS_DLQ_STREAM: `test:lag:${lagTag}:dlq`,
        EVENTS_CONSUMER_GROUP: `lag-${lagTag}`,
        METRICS_TOKEN: TOKEN,
      }),
      captureLogger().logger,
      { models },
    );
    await idle.start();
    try {
      const base = `http://127.0.0.1:${(idle.app.server.address() as AddressInfo).port}`;
      const projectId = await createProject(idle.db);
      const apiKey = (await createApiKey(idle.db, projectId)).plaintext;
      const viewer = await createUser(idle.db, [{ projectId, role: 'viewer' }]);
      const login = await fetch(`${base}/admin/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: viewer.email, password: viewer.password }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
      const unread = async () => {
        const res = await fetch(`${base}/admin/analytics/infra?projectId=${projectId}&range=1h`, {
          headers: { cookie },
        });
        return ((await res.json()) as { pipeline: { unreadEvents: number } }).pipeline.unreadEvents;
      };

      expect(sample(await scrape(base), 'usage_stream_lag')).toBe(0);
      expect(await unread()).toBe(0);
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'mock-ok', messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(200);
      }
      await vi.waitFor(async () => expect(sample(await scrape(base), 'usage_stream_lag')).toBe(3));
      expect(await unread()).toBe(3);
      expect(sample(await scrape(base), 'usage_stream_up')).toBe(1);
    } finally {
      await idle.shutdown();
    }
  });
});
