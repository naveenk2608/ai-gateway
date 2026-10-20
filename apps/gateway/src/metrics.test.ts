import { uuidv7, type AttemptRecord, type UsageEvent } from '@ai-gateway/shared';
import { createMetricsRegistry } from '@ai-gateway/shared/node';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../test/helpers.js';
import { buildApp } from './app.js';
import type { EventBusStats } from './events/bus.js';
import { GatewayMetrics, type MetricLabels } from './metrics.js';
import { BreakerBoard } from './routing/breaker.js';
import { ManualClock } from '@ai-gateway/shared';

const LABELS: MetricLabels = {
  deployments: [
    { id: 'primary', provider: 'mock', providerModel: 'mock-large' },
    { id: 'secondary', provider: 'ollama', providerModel: 'llama3' },
  ],
  models: ['chat'],
};

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function attempt(
  n: number,
  deployment: string,
  outcome: string,
  extra: Partial<AttemptRecord> = {},
) {
  const known = LABELS.deployments.find((d) => d.id === deployment);
  return {
    id: uuidv7(),
    attemptNumber: n,
    deployment,
    provider: known?.provider ?? deployment,
    providerModel: known?.providerModel ?? deployment,
    outcome,
    upstreamStatus: null,
    routingPolicy: 'priority',
    routingReason: 'priority 1',
    startedAt: iso(0),
    completedAt: iso(1_000),
    latencyMs: 1_000,
    ttftMs: null,
    ...extra,
  } satisfies AttemptRecord;
}

function event(
  overrides: Partial<Omit<UsageEvent, 'request'>> & {
    request?: Partial<UsageEvent['request']>;
  } = {},
) {
  const { request, ...rest } = overrides;
  return {
    v: 1,
    type: 'request.completed',
    eventId: uuidv7(),
    occurredAt: iso(1_000),
    request: {
      id: uuidv7(),
      projectId: uuidv7(),
      apiKeyId: uuidv7(),
      model: 'chat',
      deployment: 'primary',
      stream: false,
      status: 'success',
      httpStatus: 200,
      errorCode: null,
      startedAt: iso(0),
      completedAt: iso(1_000),
      latencyMs: 1_000,
      ttftMs: null,
      ...request,
    },
    attempts: [attempt(1, 'primary', 'success')],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    usageSource: 'reported',
    estimatedPromptTokens: 110,
    ...rest,
  } satisfies UsageEvent;
}

function setup() {
  const registry = createMetricsRegistry();
  return { registry, metrics: new GatewayMetrics(registry, LABELS) };
}

type Registry = ReturnType<typeof createMetricsRegistry>;

/** The value of one series; histograms report their `_count` unless `suffix` says otherwise. */
async function value(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
  suffix = '',
): Promise<number | undefined> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const data = await metric.get();
  const wanted = String(data.type) === 'histogram' ? `${name}${suffix || '_count'}` : name;
  return data.values.find(
    (v) =>
      ((v as { metricName?: string }).metricName ?? name) === wanted &&
      Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want) &&
      Object.keys(v.labels).filter((k) => k !== 'le').length === Object.keys(labels).length,
  )?.value;
}

describe('GatewayMetrics.requestFinished', () => {
  it('counts each attempt, and tells retries from fallbacks', async () => {
    const { registry, metrics } = setup();
    metrics.requestFinished(
      event({
        attempts: [
          attempt(1, 'primary', 'timeout'),
          attempt(2, 'primary', 'server_error'),
          attempt(3, 'secondary', 'success'),
        ],
      }),
    );
    const attempts = 'gateway_upstream_attempts_total';
    expect(
      await value(registry, attempts, {
        provider: 'mock',
        deployment: 'primary',
        model: 'mock-large',
        outcome: 'timeout',
      }),
    ).toBe(1);
    expect(
      await value(registry, attempts, {
        provider: 'ollama',
        deployment: 'secondary',
        model: 'llama3',
        outcome: 'success',
      }),
    ).toBe(1);
    expect(await value(registry, 'gateway_retries_total', { deployment: 'primary' })).toBe(1);
    expect(await value(registry, 'gateway_fallbacks_total', { model: 'chat' })).toBe(1);
  });

  it('records TTFT, output tokens per second and the prompt estimate error', async () => {
    const { registry, metrics } = setup();
    metrics.requestFinished(
      event({
        request: { stream: true, ttftMs: 250 },
        attempts: [attempt(1, 'primary', 'success', { latencyMs: 1_200, ttftMs: 200 })],
      }),
    );
    expect(await value(registry, 'gateway_ttft_seconds', { deployment: 'primary' }, '_sum')).toBe(
      0.25,
    );
    // 50 completion tokens over the 1 s after the first token.
    expect(
      await value(
        registry,
        'gateway_output_tokens_per_second',
        { deployment: 'primary', stream: 'true' },
        '_sum',
      ),
    ).toBe(50);
    // Estimated 110 against 100 reported: 10 % over.
    expect(
      await value(
        registry,
        'gateway_prompt_token_estimate_error_ratio',
        { deployment: 'primary' },
        '_sum',
      ),
    ).toBeCloseTo(0.1);
  });

  it('skips speed and estimate metrics for cache hits, failures and unreported usage', async () => {
    const { registry, metrics } = setup();
    metrics.requestFinished(event({ attempts: [], cacheHit: true }));
    metrics.requestFinished(
      event({ request: { status: 'error' }, attempts: [attempt(1, 'primary', 'timeout')] }),
    );
    metrics.requestFinished(event({ usageSource: 'estimated' }));
    expect(
      await value(registry, 'gateway_output_tokens_per_second', {
        deployment: 'primary',
        stream: 'false',
      }),
    ).toBeUndefined();
    expect(
      await value(registry, 'gateway_prompt_token_estimate_error_ratio', { deployment: 'primary' }),
    ).toBeUndefined();
  });

  it('counts admission rejections by reason', async () => {
    const { registry, metrics } = setup();
    const rejected = (errorCode: string, httpStatus = 429) =>
      event({
        request: { status: 'rejected', errorCode, httpStatus, deployment: null },
        attempts: [],
        usage: null,
        usageSource: 'missing',
      });
    metrics.requestFinished(rejected('rpm_limit_exceeded'));
    metrics.requestFinished(rejected('rpm_limit_exceeded'));
    metrics.requestFinished(rejected('budget_exceeded'));
    metrics.requestFinished(rejected('limits_unavailable', 503));
    metrics.requestFinished(rejected('model_not_allowed', 403));
    const name = 'gateway_admission_rejections_total';
    expect(await value(registry, name, { reason: 'rpm' })).toBe(2);
    expect(await value(registry, name, { reason: 'budget' })).toBe(1);
    expect(await value(registry, name, { reason: 'limits_unavailable' })).toBe(1);
    const reasons = (await registry.getSingleMetric(name)!.get()).values.map(
      (v) => v.labels.reason,
    );
    expect(reasons).not.toContain('model_not_allowed');
  });
});

describe('GatewayMetrics.watch', () => {
  function watched(checks: Record<string, () => Promise<void>> = {}) {
    const { registry, metrics } = setup();
    const clock = new ManualClock(T0);
    const breakers = new BreakerBoard(
      ['primary', 'secondary'],
      { failureThreshold: 1, openMs: 1_000 },
      clock,
      (t) => metrics.breakerTransition(t),
    );
    const stats: EventBusStats = { buffered: 3, published: 40, dropped: 2 };
    const events = { publish: () => undefined, stats: () => stats, close: () => Promise.resolve() };
    const pool = { totalCount: 4, idleCount: 1, waitingCount: 0 };
    metrics.watch({ breakers, events, pool, checks, timeoutMs: 50 });
    return { registry, breakers, stats };
  }

  it('reports breaker states and transitions', async () => {
    const { registry, breakers } = watched();
    breakers.get('primary').onFailure('timeout');
    const state = 'gateway_circuit_breaker_state';
    expect(await value(registry, state, { deployment: 'primary', state: 'open' })).toBe(1);
    expect(await value(registry, state, { deployment: 'primary', state: 'closed' })).toBe(0);
    expect(await value(registry, state, { deployment: 'secondary', state: 'closed' })).toBe(1);
    expect(
      await value(registry, 'gateway_circuit_breaker_transitions_total', {
        deployment: 'primary',
        to: 'open',
      }),
    ).toBe(1);
  });

  it('reads the event bus and the Postgres pool at scrape time', async () => {
    const { registry, stats } = watched();
    expect(await value(registry, 'gateway_usage_events_published_total')).toBe(40);
    stats.published = 45;
    expect(await value(registry, 'gateway_usage_events_published_total')).toBe(45);
    expect(await value(registry, 'gateway_usage_events_dropped_total')).toBe(2);
    expect(await value(registry, 'gateway_usage_events_buffered')).toBe(3);
    expect(await value(registry, 'gateway_pg_pool_clients', { state: 'idle' })).toBe(1);
  });

  it('marks a failing or slow dependency down, probing once per scrape', async () => {
    let redisCalls = 0;
    const { registry } = watched({
      postgres: () => Promise.reject(new Error('refused')),
      redis: () => {
        redisCalls++;
        return Promise.resolve();
      },
      slow: () => new Promise(() => undefined),
    });
    const text = await registry.metrics();
    expect(text).toContain('gateway_dependency_up{dependency="postgres"} 0');
    expect(text).toContain('gateway_dependency_up{dependency="redis"} 1');
    expect(text).toContain('gateway_dependency_up{dependency="slow"} 0');
    expect(text).toMatch(/gateway_dependency_latency_seconds\{dependency="slow"\} 0\.0[5-9]/);
    expect(redisCalls).toBe(1);
  });
});

describe('label cardinality', () => {
  /** Labels the gateway may use; an ID or free-text label added later fails this test. */
  const ALLOWED_LABELS = new Set([
    'method',
    'route',
    'status_code',
    'provider',
    'deployment',
    'model',
    'outcome',
    'state',
    'to',
    'result',
    'reason',
    'stream',
    'dependency',
    'le',
  ]);

  /** A seeded generator, so a failure is reproducible. */
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  it('stays bounded however many distinct client values arrive', async () => {
    const { logger } = captureLogger();
    const { registry, metrics } = setup();
    const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 }, metrics });
    app.get('/items/:id', () => ({ ok: true }));
    const next = random(42);
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const fresh: string[] = [];
    const unique = () => {
      const value = `u${Math.floor(next() * 1e12).toString(36)}`;
      fresh.push(value);
      return value;
    };

    async function traffic(n: number) {
      for (let i = 0; i < n; i++) {
        // What a client controls: model names, URLs and IDs; what the code knows: config.
        const deployment = pick(['primary', 'secondary', unique()]);
        const outcome = pick(['success', 'timeout', 'canceled', unique()]);
        metrics.requestFinished(
          event({
            request: {
              model: pick(['chat', unique()]),
              stream: next() < 0.5,
              ttftMs: 100,
              status: pick(['success', 'rejected']),
              errorCode: pick([null, 'rpm_limit_exceeded', unique()]),
            },
            attempts: [
              attempt(1, pick(['primary', unique()]), pick(['timeout', unique()])),
              attempt(2, deployment, outcome),
            ],
          }),
        );
        metrics.cacheLookup(next() < 0.5);
        metrics.httpRequest(pick(['GET', unique()]), undefined, 404, 0.01);
      }
      for (let i = 0; i < n / 20; i++) {
        await app.inject({
          method: pick(['GET', 'POST']),
          url: `/items/${unique()}?q=${unique()}`,
        });
        await app.inject({ url: `/${unique()}/${unique()}` });
      }
    }

    async function seriesPerMetric() {
      const counts = new Map<string, number>();
      for (const metric of await registry.getMetricsAsJSON()) {
        if (!metric.name.startsWith('gateway_')) continue;
        const series = new Set(
          metric.values.map((v) =>
            JSON.stringify(
              Object.entries(v.labels)
                .filter(([k]) => k !== 'le')
                .sort(),
            ),
          ),
        );
        counts.set(metric.name, series.size);
        for (const v of metric.values) {
          for (const label of Object.keys(v.labels)) expect(ALLOWED_LABELS).toContain(label);
        }
      }
      return counts;
    }

    await traffic(1_000);
    const first = await seriesPerMetric();
    await traffic(1_000);
    const second = await seriesPerMetric();

    // Twice the distinct client values, not one more series.
    expect(second).toEqual(first);
    for (const [name, count] of second) expect(count, name).toBeLessThanOrEqual(64);
    const text = await registry.metrics();
    expect(fresh.length).toBeGreaterThan(4_000);
    expect(fresh.some((value) => text.includes(value))).toBe(false);
  });
});
