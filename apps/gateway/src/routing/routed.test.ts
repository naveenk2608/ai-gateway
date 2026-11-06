import { systemClock, type Clock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import { GatewayError } from '../errors.js';
import { PriceBook } from '../limits/prices.js';
import type { RoutingPolicy } from '../models-config.js';
import { ProviderError, type ProviderErrorKind } from '../providers/errors.js';
import type { Deployment, Route } from '../providers/registry.js';
import type { AttemptContext, TimeoutPhase } from '../proxy/attempt.js';
import { RequestTrace } from '../proxy/trace.js';
import { BreakerBoard } from './breaker.js';
import { runRouted, type RetrySettings } from './routed.js';
import { LatencyTracker } from './router.js';

/** A timeout the gateway imposed: which limit cut the try, and after how long. */
interface Cut {
  cut: TimeoutPhase;
  afterMs: number;
}

type Outcome = 'ok' | ProviderErrorKind | ProviderError | Cut;

const deployment = (id: string) =>
  ({
    id,
    providerModel: id,
    provider: { kind: 'mock' },
    providerName: 'mock',
    maxOutputTokens: 100,
    timeoutMs: 60_000,
  }) as unknown as Deployment;

/** A clock whose sleeps resolve at once, recording how long each would have been. */
function recordingClock() {
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => systemClock.now(),
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return signal?.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
    },
  };
  return { clock, sleeps };
}

function setup(
  outcomes: Record<string, Outcome[]>,
  {
    policy = 'priority',
    retry = {},
    failureThreshold = 100,
  }: { policy?: RoutingPolicy; retry?: Partial<RetrySettings>; failureThreshold?: number } = {},
) {
  const { logger } = captureLogger();
  const { clock, sleeps } = recordingClock();
  const ids = Object.keys(outcomes);
  const route: Route = {
    model: 'm',
    type: 'chat',
    policy,
    targets: ids.map((id) => ({ deployment: deployment(id), weight: 1, lastResort: false })),
  };
  const breakers = new BreakerBoard(ids, { failureThreshold, openMs: 60_000 }, clock, () => {});
  const deps = {
    breakers,
    latency: new LatencyTracker(),
    prices: PriceBook.of([], clock, logger),
    random: () => 0.5,
    retry: { maxAttempts: 3, perDeployment: 2, baseDelayMs: 100, maxDelayMs: 2_000, ...retry },
  };
  const calls: { id: string; reason: string }[] = [];
  /** Each attempt's `passedOver`, by deployment. */
  const passed: [string, readonly string[] | undefined][] = [];
  const start = (ctx: AttemptContext): Promise<string> => {
    const id = ctx.deployment.id;
    calls.push({ id, reason: ctx.routing?.reason ?? '' });
    passed.push([id, ctx.passedOver]);
    const next = outcomes[id]!.shift() ?? 'ok';
    const cut = typeof next === 'object' && 'cut' in next ? next : undefined;
    const error =
      next === 'ok'
        ? undefined
        : next instanceof ProviderError
          ? next
          : cut
            ? new ProviderError('timeout', `cut at ${cut.afterMs} ms (${cut.cut})`)
            : new ProviderError(next as ProviderErrorKind, next as string);
    ctx.onEnd?.({
      error,
      latencyMs: cut?.afterMs ?? 10,
      ttftMs: null,
      usage: null,
      timeoutPhase: cut?.cut,
    });
    return error ? Promise.reject(error) : Promise.resolve(`served by ${id}`);
  };
  const run = (signal = new AbortController().signal) => {
    const trace = new RequestTrace(
      {
        requestId: '0192f000-0000-7000-8000-000000000001',
        projectId: '0192f000-0000-7000-8000-000000000002',
        apiKeyId: null,
        model: 'm',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      },
      clock,
    );
    return runRouted(
      deps,
      { route, trace, clock, clientSignal: signal, log: logger, maxTokens: 100 },
      start,
    );
  };
  return { run, calls, sleeps, breakers, passed };
}

describe('runRouted', () => {
  it('retries a retryable failure with full-jitter backoff, then falls back', async () => {
    const t = setup({ primary: ['server_error', 'server_error'], secondary: ['ok'] });
    expect(await t.run()).toBe('served by secondary');
    // random() = 0.5 of a 100 ms ceiling.
    expect(t.sleeps).toEqual([50]);
    expect(t.calls).toEqual([
      { id: 'primary', reason: 'priority 1 of 2' },
      { id: 'primary', reason: 'retry 1 on primary after server_error, waited 50 ms' },
      { id: 'secondary', reason: 'priority 2 of 2; fallback after primary failed (server_error)' },
    ]);
  });

  it('doubles the backoff ceiling on each retry, up to the maximum', async () => {
    const t = setup(
      { a: ['timeout', 'timeout', 'timeout', 'timeout', 'timeout'] },
      { retry: { maxAttempts: 5, perDeployment: 5, baseDelayMs: 1_000, maxDelayMs: 3_000 } },
    );
    await expect(t.run()).rejects.toMatchObject({ kind: 'timeout' });
    expect(t.sleeps).toEqual([500, 1_000, 1_500, 1_500]);
  });

  it('falls back without retrying failures that would fail the same way', async () => {
    const t = setup({ primary: ['auth'], secondary: ['ok'] });
    expect(await t.run()).toBe('served by secondary');
    expect(t.calls.map((c) => c.id)).toEqual(['primary', 'secondary']);
    expect(t.sleeps).toEqual([]);
  });

  it('neither retries nor falls back when the request itself was rejected or the client left', async () => {
    for (const kind of ['bad_request', 'canceled'] as const) {
      const t = setup({ primary: [kind], secondary: ['ok'] });
      await expect(t.run()).rejects.toMatchObject({ kind });
      expect(t.calls.map((c) => c.id)).toEqual(['primary']);
    }
  });

  it('waits at least Retry-After, or moves on when it is longer than the maximum backoff', async () => {
    const soon = new ProviderError('rate_limited', '429', { retryAfterMs: 700 });
    const t = setup({ primary: [soon, 'ok'] });
    expect(await t.run()).toBe('served by primary');
    expect(t.sleeps).toEqual([700]);

    const late = new ProviderError('rate_limited', '429', { retryAfterMs: 60_000 });
    const u = setup({ primary: [late], secondary: ['ok'] });
    expect(await u.run()).toBe('served by secondary');
    expect(u.sleeps).toEqual([]);
  });

  it('stops after RETRY_MAX_ATTEMPTS and reports the last failure', async () => {
    const t = setup(
      { a: ['server_error', 'server_error'], b: ['connection', 'connection'], c: ['ok'] },
      { retry: { maxAttempts: 3 } },
    );
    await expect(t.run()).rejects.toMatchObject({ kind: 'connection' });
    expect(t.calls.map((c) => c.id)).toEqual(['a', 'a', 'b']);
  });

  it('skips a deployment whose breaker is open and says so on the next attempt', async () => {
    const t = setup(
      { primary: ['server_error', 'server_error'], secondary: ['ok', 'ok'] },
      { failureThreshold: 2 },
    );
    await t.run();
    expect(t.breakers.get('primary').state).toBe('open');
    t.calls.length = 0;
    expect(await t.run()).toBe('served by secondary');
    expect(t.calls).toEqual([
      { id: 'secondary', reason: 'priority 2 of 2; skipped primary (circuit open)' },
    ]);
  });

  it('tells each attempt which deployments were passed over before it, retries excluded', async () => {
    const t = setup(
      { a: ['server_error', 'server_error'], b: ['auth'], c: ['ok'] },
      {
        retry: { maxAttempts: 5 },
      },
    );
    expect(await t.run()).toBe('served by c');
    expect(t.passed).toEqual([
      ['a', []],
      ['a', []],
      ['b', ['a']],
      ['c', ['a', 'b']],
    ]);
  });

  it('counts a deployment skipped while its circuit is open as passed over', async () => {
    const t = setup(
      { primary: ['server_error', 'server_error'], secondary: ['ok', 'ok'] },
      { failureThreshold: 2 },
    );
    await t.run();
    t.passed.length = 0;
    await t.run();
    expect(t.passed).toEqual([['secondary', ['primary']]]);
  });

  it('fails fast with 503 when every breaker is open', async () => {
    const t = setup({ only: ['server_error', 'server_error'] }, { failureThreshold: 2 });
    await expect(t.run()).rejects.toMatchObject({ kind: 'server_error' });
    const err = await t.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({
      httpStatus: 503,
      code: 'deployments_unavailable',
      retryAfterSeconds: 60,
    });
  });

  it('counts no breaker failure for a try the request deadline cut before its timeout', async () => {
    // One try: in the gateway, no retry starts once the deadline has passed.
    const t = setup(
      { only: [{ cut: 'deadline', afterMs: 5_000 }] },
      { failureThreshold: 1, retry: { perDeployment: 1 } },
    );
    await expect(t.run()).rejects.toMatchObject({ kind: 'timeout' });
    expect(t.breakers.get('only').state).toBe('closed');
  });

  it('still counts a try that ran its whole timeout, whichever limit cut it', async () => {
    for (const cut of [
      { cut: 'deadline', afterMs: 60_000 },
      { cut: 'response', afterMs: 60_000 },
    ] as const) {
      const t = setup({ only: [cut] }, { failureThreshold: 1, retry: { perDeployment: 1 } });
      await expect(t.run()).rejects.toMatchObject({ kind: 'timeout' });
      expect(t.breakers.get('only').state).toBe('open');
    }
  });

  it('frees a half-open trial that the deadline cut short', async () => {
    const t = setup(
      { only: ['server_error', { cut: 'deadline', afterMs: 5_000 }, 'ok'] },
      { failureThreshold: 1, retry: { perDeployment: 1 } },
    );
    await expect(t.run()).rejects.toMatchObject({ kind: 'server_error' });
    // Past the open period: the next request is the trial.
    t.breakers.get('only').probeSucceeded();
    expect(t.breakers.get('only').state).toBe('half_open');
    await expect(t.run()).rejects.toMatchObject({ kind: 'timeout' });
    // Neither opened again nor stuck: the next request may be the trial.
    expect(t.breakers.get('only').state).toBe('half_open');
    expect(await t.run()).toBe('served by only');
    expect(t.breakers.get('only').state).toBe('closed');
  });

  it('stops waiting to retry when the client leaves', async () => {
    const t = setup({ primary: ['server_error'], secondary: ['ok'] });
    const client = new AbortController();
    client.abort();
    await expect(t.run(client.signal)).rejects.toMatchObject({ kind: 'canceled' });
  });
});
