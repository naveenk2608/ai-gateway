import type { Clock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { PriceBook } from '../limits/prices.js';
import { ProviderError } from '../providers/errors.js';
import type { Deployment, Route } from '../providers/registry.js';
import type { AttemptContext } from '../proxy/attempt.js';
import { RequestTrace } from '../proxy/trace.js';
import { BreakerBoard } from './breaker.js';
import { RetryBudget, type RetryBudgetSettings } from './retry-budget.js';
import { runRouted } from './routed.js';
import { LatencyTracker } from './router.js';

function handClock(start = 1_000_000) {
  let now = start;
  const clock: Clock = { now: () => now, sleep: () => Promise.resolve() };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const SETTINGS: RetryBudgetSettings = {
  enabled: true,
  ratio: 0.2,
  minRetries: 3,
  windowMs: 10_000,
};

describe('RetryBudget', () => {
  it('allows the larger of the floor and the share of first tries in the window', () => {
    const t = handClock();
    const budget = new RetryBudget(SETTINGS, t.clock);
    expect(budget.usage('a')).toEqual({ first: 0, retries: 0, allowed: 3 });
    for (let i = 0; i < 15; i++) budget.firstTry('a');
    expect(budget.usage('a').allowed).toBe(3);
    for (let i = 0; i < 10; i++) budget.firstTry('a');
    expect(budget.usage('a').allowed).toBe(5);
  });

  it('refuses retries past the budget, counts refusals, and recovers as the window slides', () => {
    const t = handClock();
    const skipped: string[] = [];
    const budget = new RetryBudget(SETTINGS, t.clock, (d) => skipped.push(d));
    budget.firstTry('a');
    expect([1, 2, 3, 4].map(() => budget.tryRetry('a'))).toEqual([true, true, true, false]);
    expect(skipped).toEqual(['a']);
    // Another deployment has its own budget.
    expect(budget.tryRetry('b')).toBe(true);
    t.advance(10_001);
    expect(budget.usage('a')).toEqual({ first: 0, retries: 0, allowed: 3 });
    expect(budget.tryRetry('a')).toBe(true);
  });

  it('allows every retry when switched off', () => {
    const t = handClock();
    const budget = new RetryBudget({ ...SETTINGS, enabled: false }, t.clock);
    expect(Array.from({ length: 50 }, () => budget.tryRetry('a')).every(Boolean)).toBe(true);
  });
});

describe('runRouted with a retry budget', () => {
  const deployment = (id: string) =>
    ({
      id,
      providerModel: id,
      provider: { kind: 'mock' },
      providerName: 'mock',
      maxOutputTokens: 100,
      timeoutMs: 60_000,
    }) as unknown as Deployment;

  function setup(failing: (n: number) => boolean) {
    const { logger } = captureLogger();
    const t = handClock();
    const route: Route = {
      model: 'm',
      type: 'chat',
      policy: 'priority',
      targets: ['a', 'b'].map((id) => ({
        deployment: deployment(id),
        weight: 1,
        lastResort: false,
      })),
    };
    const skips: string[] = [];
    const deps = {
      // A threshold no burst reaches: the budget, not the breaker, is under test.
      breakers: new BreakerBoard(
        ['a', 'b'],
        { failureThreshold: 10_000, openMs: 60_000 },
        t.clock,
        () => {},
      ),
      latency: new LatencyTracker(),
      prices: PriceBook.of([], t.clock, logger),
      random: () => 0.5,
      retry: { maxAttempts: 3, perDeployment: 2, baseDelayMs: 100, maxDelayMs: 2_000 },
      retryBudget: new RetryBudget(SETTINGS, t.clock, (d) => skips.push(d)),
    };
    const calls: { id: string; reason: string }[] = [];
    let triesOnA = 0;
    const start = (ctx: AttemptContext): Promise<string> => {
      const id = ctx.deployment.id;
      calls.push({ id, reason: ctx.routing?.reason ?? '' });
      const fails = id === 'a' && failing(triesOnA++);
      const error = fails ? new ProviderError('server_error', 'down') : undefined;
      ctx.onEnd?.({ error, latencyMs: 10, ttftMs: null, usage: null });
      return error ? Promise.reject(error) : Promise.resolve(`served by ${id}`);
    };
    const run = () => {
      const trace = new RequestTrace(
        {
          requestId: '0192f000-0000-7000-8000-000000000001',
          projectId: '0192f000-0000-7000-8000-000000000002',
          apiKeyId: null,
          model: 'm',
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        },
        t.clock,
      );
      return runRouted(
        deps,
        {
          route,
          trace,
          clock: t.clock,
          clientSignal: new AbortController().signal,
          log: logger,
          maxTokens: 100,
        },
        start,
      );
    };
    return { run, calls, skips, advance: t.advance };
  }

  it('keeps retries on a failing deployment within its budget during a burst', async () => {
    const s = setup(() => true);
    for (let i = 0; i < 50; i++) {
      expect(await s.run()).toBe('served by b');
      s.advance(100);
    }
    const retries = s.calls.filter((c) => c.id === 'a' && c.reason.startsWith('retry'));
    // 50 first tries in 5 s, all in one window: at most 20% of them (10), against 50 without it.
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.length).toBeLessThanOrEqual(10);
    expect(s.skips.length).toBe(50 - retries.length);
    expect(s.calls.filter((c) => c.id === 'a' && !c.reason.startsWith('retry'))).toHaveLength(50);
    // The 4th request is the first past the floor of 3: it falls back without retrying.
    const fallbacks = s.calls.filter((c) => c.id === 'b').map((c) => c.reason);
    expect(fallbacks[3]).toBe(
      'priority 2 of 2; fallback after a failed (server_error), retry budget used up',
    );
    expect(fallbacks[0]).toBe('priority 2 of 2; fallback after a failed (server_error)');
  });

  it('still retries a single failure in quiet traffic', async () => {
    let failures = 0;
    const s = setup((n) => n === 20 && ++failures === 1);
    for (let i = 0; i < 25; i++) {
      await s.run();
      s.advance(2_000);
    }
    expect(s.skips).toEqual([]);
    const retry = s.calls.findIndex((c) => c.reason.startsWith('retry 1 on a'));
    expect(retry).toBeGreaterThan(0);
    expect(s.calls[retry]!.id).toBe('a');
    expect(s.calls.filter((c) => c.id === 'b')).toHaveLength(0);
  });
});
