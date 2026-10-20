import { createMetricsRegistry } from '@ai-gateway/shared/node';
import { describe, expect, it } from 'vitest';
import { WorkerMetrics } from './metrics.js';
import type { PipelineState } from './pipeline.js';

const STATE: PipelineState = {
  streamLength: 12,
  unreadEvents: 7,
  pendingEvents: 2,
  oldestPendingAgeMs: 1_500,
  consumers: 1,
  deadLetterLength: 1,
};

describe('WorkerMetrics', () => {
  it('reads the pipeline once per scrape and reports it', async () => {
    const registry = createMetricsRegistry();
    let reads = 0;
    new WorkerMetrics(registry).watchPipeline(() => {
      reads++;
      return Promise.resolve(STATE);
    });
    const text = await registry.metrics();
    expect(text).toContain('worker_stream_up 1');
    expect(text).toContain('worker_stream_lag 7');
    expect(text).toContain('worker_stream_pending 2');
    expect(text).toContain('worker_stream_oldest_pending_age_seconds 1.5');
    expect(text).toContain('worker_dlq_length 1');
    expect(reads).toBe(1);
  });

  it('reports the stream down, without stale values, when Redis does not answer', async () => {
    const registry = createMetricsRegistry();
    let state: Promise<PipelineState> = Promise.resolve(STATE);
    new WorkerMetrics(registry).watchPipeline(() => state);
    await registry.metrics();
    state = Promise.reject(new Error('connection refused'));
    const text = await registry.metrics();
    expect(text).toContain('worker_stream_up 0');
    // prom-client writes NaN as `Nan`; Prometheus parses it either way.
    expect(text).toMatch(/^worker_stream_lag nan$/im);
    expect(text).toMatch(/^worker_dlq_length nan$/im);
  });

  it('counts consumption and pruned rows by table', async () => {
    const registry = createMetricsRegistry();
    const metrics = new WorkerMetrics(registry);
    metrics.consumed(3);
    metrics.consumed(2);
    metrics.deadLettered();
    metrics.pruned(0.2, { minute: 10, hour: 0, day: 1 });
    const text = await registry.metrics();
    expect(text).toContain('worker_events_consumed_total 5');
    expect(text).toContain('worker_events_dead_lettered_total 1');
    expect(text).toContain('worker_rollup_rows_pruned_total{table="minute"} 10');
    expect(text).toContain('worker_prune_duration_seconds_count 1');
  });
});
