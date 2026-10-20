import { systemClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { PriceBook } from '../limits/prices.js';
import type { RoutingPolicy } from '../models-config.js';
import type { Deployment, Route } from '../providers/registry.js';
import { LatencyTracker, planRoute, type PlanContext } from './router.js';

const deployment = (id: string, providerModel = id) =>
  ({ id, providerModel, provider: { kind: 'mock' } }) as unknown as Deployment;

function route(policy: RoutingPolicy, weights: Record<string, number>): Route {
  return {
    model: 'm',
    policy,
    targets: Object.entries(weights).map(([id, weight]) => ({
      deployment: deployment(id),
      weight,
    })),
  };
}

function context(overrides: Partial<PlanContext> = {}): PlanContext {
  const { logger } = captureLogger();
  return {
    latency: new LatencyTracker(),
    prices: PriceBook.of([], systemClock, logger),
    random: () => 0,
    at: 0,
    promptTokens: 10,
    maxTokens: 100,
    ...overrides,
  };
}

const ids = (candidates: { deployment: Deployment }[]) => candidates.map((c) => c.deployment.id);

describe('planRoute', () => {
  it('priority: the configured order', () => {
    const plan = planRoute(route('priority', { a: 1, b: 1 }), context());
    expect(plan.map((c) => [c.deployment.id, c.reason])).toEqual([
      ['a', 'priority 1 of 2'],
      ['b', 'priority 2 of 2'],
    ]);
  });

  it('weighted: picks in proportion to weight, the rest as fallbacks', () => {
    const r = route('weighted', { a: 1, b: 3 });
    // random() * 4: [0, 1) picks a, [1, 4) picks b.
    expect(ids(planRoute(r, context({ random: () => 0.2 })))).toEqual(['a', 'b']);
    expect(ids(planRoute(r, context({ random: () => 0.3 })))).toEqual(['b', 'a']);
    expect(planRoute(r, context({ random: () => 0.5 }))[0]?.reason).toBe(
      'weighted pick (weight 3 of 4)',
    );
    let picksOfB = 0;
    let seed = 1;
    const random = () => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
    for (let i = 0; i < 4_000; i++)
      if (planRoute(r, context({ random }))[0]?.deployment.id === 'b') picksOfB++;
    expect(picksOfB / 4_000).toBeCloseTo(0.75, 1);
  });

  it('lowest latency: unmeasured first, then by EWMA', () => {
    const latency = new LatencyTracker(0.5);
    latency.record('a', 300);
    latency.record('b', 100);
    latency.record('b', 300); // EWMA 200
    const plan = planRoute(route('lowest_latency', { a: 1, b: 1, c: 1 }), context({ latency }));
    expect(plan.map((c) => [c.deployment.id, c.reason])).toEqual([
      ['c', 'lowest latency: not measured yet'],
      ['b', 'latency rank 2: EWMA 200 ms'],
      ['a', 'latency rank 3: EWMA 300 ms'],
    ]);
  });

  it('cost-aware: cheapest worst case first; unpriced counts as free', () => {
    const { logger } = captureLogger();
    const price = (model: string, out: number) => ({
      id: model,
      provider: 'mock',
      model,
      inputMicroUsdPerMTok: 0,
      outputMicroUsdPerMTok: out,
      effectiveFrom: 0,
    });
    const prices = PriceBook.of(
      [price('a', 2_000_000), price('b', 1_000_000)],
      systemClock,
      logger,
    );
    const plan = planRoute(route('cost_aware', { a: 1, b: 1, free: 1 }), context({ prices }));
    expect(plan.map((c) => [c.deployment.id, c.reason])).toEqual([
      ['free', 'cheapest: at most 0 micro-USD'],
      ['b', 'cost rank 2: at most 100 micro-USD'],
      ['a', 'cost rank 3: at most 200 micro-USD'],
    ]);
  });
});
