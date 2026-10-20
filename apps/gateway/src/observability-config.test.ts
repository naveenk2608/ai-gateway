import { readFileSync } from 'node:fs';
import { ManualClock, parseConfig } from '@ai-gateway/shared';
import { createMetricsRegistry } from '@ai-gateway/shared/node';
import { watchPipeline, WorkerMetrics, workerConfigSchema } from '@ai-gateway/worker';
import { describe, expect, it } from 'vitest';
import { GatewayMetrics } from './metrics.js';
import { BreakerBoard } from './routing/breaker.js';

/** The Compose observability profile (ADR 017) must query only metrics the code registers. */
const read = (path: string) =>
  readFileSync(new URL(`../../../infra/compose/${path}`, import.meta.url), 'utf8');

interface Panel {
  title: string;
  datasource: { uid: string };
  targets: { expr: string; datasource: { uid: string } }[];
}

async function registeredMetrics(): Promise<Map<string, string>> {
  const registry = createMetricsRegistry();
  const gateway = new GatewayMetrics(registry, { deployments: [], models: [] });
  gateway.watch({
    breakers: new BreakerBoard(
      [],
      { failureThreshold: 1, openMs: 1 },
      new ManualClock(0),
      () => {},
    ),
    events: {
      publish: () => undefined,
      stats: () => ({ buffered: 0, published: 0, dropped: 0 }),
      close: () => Promise.resolve(),
    },
    pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    checks: {},
    timeoutMs: 10,
  });
  new WorkerMetrics(registry);
  watchPipeline(registry, () => Promise.reject(new Error('no redis in tests')));
  const metrics = await registry.getMetricsAsJSON();
  return new Map(metrics.map((m) => [m.name, String(m.type)]));
}

describe('Grafana dashboard', () => {
  const dashboard = JSON.parse(read('observability/grafana/dashboards/ai-gateway.json')) as {
    uid: string;
    panels: Panel[];
  };

  it('queries only metrics the gateway and worker register', async () => {
    const registered = await registeredMetrics();
    const known = (name: string) => {
      if (registered.has(name)) return true;
      const histogram = /^(.+)_(bucket|count|sum)$/.exec(name);
      return histogram !== null && registered.get(histogram[1]!) === 'histogram';
    };
    const queried = dashboard.panels.flatMap((p) =>
      p.targets.flatMap(
        (t) => t.expr.match(/\b(?:gateway|worker|usage|process|nodejs)_[a-z0-9_]+/g) ?? [],
      ),
    );
    expect(queried.length).toBeGreaterThan(20);
    expect(queried.filter((name) => !known(name))).toEqual([]);
  });

  it('uses the provisioned Prometheus datasource in every panel', () => {
    const uid = /uid:\s*(\S+)/.exec(
      read('observability/grafana/provisioning/datasources/prometheus.yml'),
    )?.[1];
    expect(uid).toBe('prometheus');
    for (const panel of dashboard.panels) {
      expect(panel.datasource.uid, panel.title).toBe(uid);
      for (const target of panel.targets) expect(target.datasource.uid, panel.title).toBe(uid);
    }
  });

  it('has panels for traffic, latency, errors, fallbacks, breakers, stream lag and the DLQ', () => {
    const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join('\n');
    for (const metric of [
      'gateway_http_request_duration_seconds_count',
      'gateway_http_request_duration_seconds_bucket',
      'gateway_upstream_attempts_total',
      'gateway_fallbacks_total',
      'gateway_circuit_breaker_state',
      'usage_stream_lag',
      'usage_dlq_length',
    ]) {
      expect(exprs).toContain(metric);
    }
  });
});

describe('Prometheus scrape targets', () => {
  it('match the ports the Compose services listen on', () => {
    const prometheus = read('observability/prometheus.yml');
    const compose = read('docker-compose.yml');
    const gatewayPort = /METRICS_PORT:\s*(\d+)/.exec(compose)?.[1];
    const workerPort = parseConfig(workerConfigSchema, {
      DATABASE_URL: 'postgres://gateway@localhost:5432/gateway',
      REDIS_URL: 'redis://localhost:6379',
    }).WORKER_METRICS_PORT;
    expect(prometheus).toContain(`'gateway:${gatewayPort}'`);
    expect(prometheus).toContain(`'worker:${workerPort}'`);
  });
});
