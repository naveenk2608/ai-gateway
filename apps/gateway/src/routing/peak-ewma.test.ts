import { systemClock, type Clock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { PriceBook } from '../limits/prices.js';
import { ProviderError } from '../providers/errors.js';
import type { Deployment, Route } from '../providers/registry.js';
import type { AttemptContext, TimeoutPhase } from '../proxy/attempt.js';
import { RequestTrace } from '../proxy/trace.js';
import { BreakerBoard } from './breaker.js';
import { PeakEwma, type PeakEwmaSettings } from './peak-ewma.js';
import { runRouted } from './routed.js';
import { LatencyTracker, planRoute, type PlanContext } from './router.js';

/** A clock tests move by hand; sleeps resolve at once. */
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

/** A seeded generator (mulberry32), so every run picks the same deployments. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const deployment = (id: string, timeoutMs = 60_000) =>
  ({
    id,
    providerModel: id,
    provider: { kind: 'mock' },
    providerName: 'mock',
    maxOutputTokens: 100,
    timeoutMs,
  }) as unknown as Deployment;

function route(ids: string[], lastResort: string[] = []): Route {
  return {
    model: 'm',
    type: 'chat',
    policy: 'peak_ewma',
    targets: [
      ...ids.map((id) => ({ deployment: deployment(id), weight: 1, lastResort: false })),
      ...lastResort.map((id) => ({ deployment: deployment(id), weight: 1, lastResort: true })),
    ],
  };
}

const SETTINGS: PeakEwmaSettings = { enabled: true, decayMs: 10_000, defaultMs: 1_000 };

function context(tracker: PeakEwma, random: () => number, stream = false): PlanContext {
  const { logger } = captureLogger();
  return {
    latency: new LatencyTracker(),
    peakEwma: tracker,
    stream,
    prices: PriceBook.of([], systemClock, logger),
    random,
    at: 0,
    promptTokens: 10,
    maxTokens: 100,
  };
}

/**
 * Sends `count` requests one after another: each goes to the first deployment of its plan, takes
 * that deployment's latency on the clock and records it. Returns how many each one served.
 */
function sequential(
  r: Route,
  tracker: PeakEwma,
  t: ReturnType<typeof handClock>,
  latency: Record<string, number>,
  count: number,
  random: () => number,
): Record<string, number> {
  const served: Record<string, number> = {};
  for (let n = 0; n < count; n++) {
    const id = planRoute(r, context(tracker, random))[0]!.deployment.id;
    served[id] = (served[id] ?? 0) + 1;
    tracker.begin(id);
    t.advance(latency[id]!);
    tracker.record(id, 'plain', latency[id]!);
    tracker.end(id);
  }
  return served;
}

describe('PeakEwma', () => {
  it('takes a higher sample at once and moves toward a lower one with the time since', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    tracker.record('a', 'plain', 100);
    tracker.record('a', 'plain', 400);
    expect(tracker.estimates()).toEqual([{ deployment: 'a', mode: 'plain', ms: 400 }]);
    // One decay time later, a 100 ms sample moves it by 1 - e^-1 of the way.
    t.advance(10_000);
    tracker.record('a', 'plain', 100);
    const expected = 400 * Math.exp(-1) + 100 * (1 - Math.exp(-1));
    expect(tracker.estimates()[0]!.ms).toBeCloseTo(expected, 6);
  });

  it('decays the estimate it scores toward zero, and counts tries in flight', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    tracker.record('a', 'plain', 200);
    t.advance(10_000);
    tracker.begin('a');
    tracker.begin('a');
    const s = tracker.score('a', 'plain');
    expect(s.estimateMs).toBeCloseTo(200 * Math.exp(-1), 6);
    expect(s).toMatchObject({ inFlight: 2, source: 'plain' });
    expect(s.score).toBeCloseTo(3 * 200 * Math.exp(-1), 6);
    tracker.end('a');
    tracker.end('a');
    expect(tracker.inFlight('a')).toBe(0);
  });

  it("uses the request's own mode, else the other mode, else the default", () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    expect(tracker.score('a', 'stream')).toMatchObject({ estimateMs: 1_000, source: 'default' });
    tracker.record('a', 'plain', 900);
    expect(tracker.score('a', 'stream')).toMatchObject({ estimateMs: 900, source: 'plain' });
    tracker.record('a', 'stream', 150);
    expect(tracker.score('a', 'stream')).toMatchObject({ estimateMs: 150, source: 'stream' });
    expect(tracker.score('a', 'plain')).toMatchObject({ estimateMs: 900, source: 'plain' });
  });
});

describe('planRoute with peak_ewma', () => {
  it('names the two picks and their scores, then orders the rest by score', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    tracker.record('a', 'plain', 100);
    tracker.record('b', 'plain', 300);
    tracker.record('c', 'plain', 200);
    tracker.begin('b');
    // random 0 picks a (index 0), then 0.99 picks the last of the others (c).
    const values = [0, 0.99];
    const plan = planRoute(
      route(['a', 'b', 'c'], ['mock']),
      context(tracker, () => values.shift() ?? 0),
    );
    expect(plan.map((c) => [c.deployment.id, c.reason])).toEqual([
      [
        'a',
        'peak EWMA: picked a 100 (100 ms x 0 in flight + 1) over c 200 (200 ms x 0 in flight + 1)',
      ],
      ['c', 'peak EWMA fallback 1: c 200 (200 ms x 0 in flight + 1)'],
      ['b', 'peak EWMA fallback 2: b 600 (300 ms x 1 in flight + 1)'],
      ['mock', 'last resort 1 of 1'],
    ]);
  });

  it('is ordered as lowest_latency when switched off', () => {
    const t = handClock();
    const tracker = new PeakEwma({ ...SETTINGS, enabled: false }, t.clock);
    const plan = planRoute(
      route(['a', 'b']),
      context(tracker, () => 0),
    );
    expect(plan[0]!.reason).toBe('peak_ewma off: lowest latency: not measured yet');
  });

  it('sends most requests to a deployment twice as fast, but not all of them', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    const served = sequential(
      route(['fast', 'slow']),
      tracker,
      t,
      { fast: 100, slow: 200 },
      1_000,
      seeded(7),
    );
    expect(served.fast! + served.slow!).toBe(1_000);
    expect(served.slow).toBeGreaterThan(0);
    expect(served.fast).toBeGreaterThan(served.slow! * 10);
  });

  it('moves traffic off a deployment that slows down within a few requests', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    const r = route(['a', 'b']);
    const random = seeded(11);
    sequential(r, tracker, t, { a: 100, b: 200 }, 300, random);
    // a slows to 400 ms: its next sample replaces its estimate at once.
    const after: string[] = [];
    for (let n = 0; n < 10; n++) {
      const id = planRoute(r, context(tracker, random))[0]!.deployment.id;
      after.push(id);
      const ms = id === 'a' ? 400 : 200;
      t.advance(ms);
      tracker.record(id, 'plain', ms);
    }
    expect(after.indexOf('b')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('b')).toBeLessThanOrEqual(1);
    expect(after.filter((id) => id === 'b').length).toBeGreaterThanOrEqual(8);
  });

  it('spreads concurrent requests by tries in flight', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    tracker.record('fast', 'plain', 100);
    tracker.record('slow', 'plain', 200);
    const r = route(['fast', 'slow']);
    const random = seeded(3);
    const served: Record<string, number> = { fast: 0, slow: 0 };
    // 30 requests arrive together: none has answered when the next one is routed.
    for (let n = 0; n < 30; n++) {
      const id = planRoute(r, context(tracker, random))[0]!.deployment.id;
      served[id]!++;
      tracker.begin(id);
    }
    expect(served.slow).toBeGreaterThan(5);
    expect(served.fast).toBeGreaterThan(served.slow!);
    // Scores stay within one try of each other: 100 x (fast + 1) against 200 x (slow + 1).
    expect(Math.abs(100 * (served.fast! + 1) - 200 * (served.slow! + 1))).toBeLessThanOrEqual(200);
  });

  it('tries a deployment that has no estimate yet, without giving it most traffic', () => {
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    const random = seeded(5);
    sequential(route(['a', 'b']), tracker, t, { a: 100, b: 200 }, 200, random);
    const served = sequential(
      route(['a', 'b', 'new']),
      tracker,
      t,
      { a: 100, b: 200, new: 150 },
      600,
      random,
    );
    expect(served.new).toBeGreaterThan(0);
    expect(served.new).toBeLessThan(300);
  });
});

describe('runRouted with peak_ewma', () => {
  function setup(outcome: 'ok' | { cut: TimeoutPhase; afterMs: number }, timeoutMs = 60_000) {
    const { logger } = captureLogger();
    const t = handClock();
    const tracker = new PeakEwma(SETTINGS, t.clock);
    const r: Route = {
      model: 'm',
      type: 'chat',
      policy: 'peak_ewma',
      targets: [{ deployment: deployment('a', timeoutMs), weight: 1, lastResort: false }],
    };
    const deps = {
      breakers: new BreakerBoard(
        ['a'],
        { failureThreshold: 100, openMs: 60_000 },
        t.clock,
        () => {},
      ),
      latency: new LatencyTracker(),
      peakEwma: tracker,
      prices: PriceBook.of([], t.clock, logger),
      random: () => 0,
      retry: { maxAttempts: 1, perDeployment: 1, baseDelayMs: 0, maxDelayMs: 0 },
    };
    const trace = new RequestTrace(
      {
        requestId: '0192f000-0000-7000-8000-000000000001',
        projectId: '0192f000-0000-7000-8000-000000000002',
        apiKeyId: null,
        model: 'm',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
      t.clock,
    );
    const inFlightDuringTry: number[] = [];
    const start = (ctx: AttemptContext) => {
      inFlightDuringTry.push(tracker.inFlight('a'));
      const error =
        outcome === 'ok' ? undefined : new ProviderError('timeout', `cut (${outcome.cut})`);
      ctx.onEnd?.({
        error,
        latencyMs: outcome === 'ok' ? 300 : outcome.afterMs,
        ttftMs: outcome === 'ok' ? 120 : null,
        usage: null,
        timeoutPhase: outcome === 'ok' ? undefined : outcome.cut,
        stream: true,
      });
      return error ? Promise.reject(error) : Promise.resolve('ok');
    };
    const run = () =>
      runRouted(
        deps,
        {
          route: r,
          trace,
          clock: t.clock,
          clientSignal: new AbortController().signal,
          log: logger,
          stream: true,
          maxTokens: 100,
        },
        start,
      );
    return { run, tracker, inFlightDuringTry };
  }

  it('counts a try in flight until it ends, and records a stream by its time to first token', async () => {
    const s = setup('ok');
    await s.run();
    expect(s.inFlightDuringTry).toEqual([1]);
    expect(s.tracker.inFlight('a')).toBe(0);
    expect(s.tracker.estimates()).toEqual([{ deployment: 'a', mode: 'stream', ms: 120 }]);
  });

  it('records the timeout of a try that ran its full timeout, and frees its slot', async () => {
    const s = setup({ cut: 'first_event', afterMs: 5_000 }, 5_000);
    await expect(s.run()).rejects.toMatchObject({ kind: 'timeout' });
    expect(s.tracker.inFlight('a')).toBe(0);
    expect(s.tracker.estimates()).toEqual([{ deployment: 'a', mode: 'stream', ms: 5_000 }]);
  });

  it('records nothing for a try the request deadline cut short', async () => {
    const s = setup({ cut: 'deadline', afterMs: 2_000 }, 60_000);
    await expect(s.run()).rejects.toMatchObject({ kind: 'timeout' });
    expect(s.tracker.inFlight('a')).toBe(0);
    expect(s.tracker.estimates()).toEqual([]);
  });
});
