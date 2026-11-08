import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../providers/errors.js';
import type { Deployment } from '../providers/registry.js';
import type { ChatRequest, ChatResult } from '../providers/types.js';
import { captureLogger } from '../../test/helpers.js';
import { BreakerBoard } from './breaker.js';
import { HealthChecker } from './health.js';
import type { QuotaBoard, QuotaCheck } from './quota.js';

const OPEN_MS = 10_000;
const CHAT_INTERVAL_MS = 60_000;

function setup(answer: () => Promise<ChatResult>, check: QuotaCheck = { ok: true, ticket: null }) {
  const clock = new ManualClock(0);
  const chat = vi.fn((_req: ChatRequest, _signal: AbortSignal) => answer());
  const probe = vi.fn(() => Promise.resolve());
  const deployment = {
    id: 'listed',
    probes: true,
    healthCheck: 'chat',
    providerModel: 'listed-model',
    timeoutMs: 30_000,
    quota: null,
    provider: { chat, probe },
  } as unknown as Deployment;
  const breakers = new BreakerBoard(
    ['listed'],
    { failureThreshold: 1, openMs: OPEN_MS },
    clock,
    () => undefined,
  );
  const quotas = {
    acquire: vi.fn(() => Promise.resolve(check)),
    settle: vi.fn(),
    observe: vi.fn(),
    cooldown: vi.fn(),
  };
  const checker = new HealthChecker({
    breakers,
    deployments: [deployment],
    clock,
    logger: captureLogger().logger,
    intervalMs: 5_000,
    timeoutMs: 5_000,
    chatIntervalMs: CHAT_INTERVAL_MS,
    chatMaxIntervalMs: 60 * 60_000,
    quotas: quotas as unknown as QuotaBoard,
  });
  const breaker = breakers.get('listed');
  breaker.onFailure('not_found');
  return { clock, chat, probe, quotas, checker, breaker };
}

const answered = (): Promise<ChatResult> =>
  Promise.resolve({
    content: '',
    finishReason: 'length',
    usage: { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
  });

describe('HealthChecker with chat checks (ADR 026)', () => {
  it('asks for one token instead of listing models, and counts it against the quota', async () => {
    const t = setup(answered, { ok: true, ticket: null });
    await t.checker.checkOpen();
    expect(t.probe).not.toHaveBeenCalled();
    expect(t.chat).toHaveBeenCalledOnce();
    expect(t.chat.mock.calls[0]![0]).toMatchObject({ model: 'listed-model', maxTokens: 1 });
    // The 8-token probe prompt and its 1-token output cap; corrected to the reported usage.
    expect(t.quotas.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: 'listed' }), {
      input: 8,
      output: 1,
    });
    expect(t.quotas.settle).toHaveBeenCalledWith(
      null,
      { promptTokens: 6, completionTokens: 1, totalTokens: 7 },
      8,
    );
    expect(t.breaker.state).toBe('half_open');
  });

  it('passes when the provider refuses only the request (400): the model is served', async () => {
    const t = setup(() => Promise.reject(new ProviderError('bad_request', 'max_tokens too low')));
    await t.checker.checkOpen();
    expect(t.breaker.state).toBe('half_open');
  });

  it('keeps the breaker open after a failed check until the next one, which waits its interval', async () => {
    const t = setup(() => Promise.reject(new ProviderError('not_found', 'upstream status 404')));
    await t.checker.checkOpen();
    expect(t.chat).toHaveBeenCalledOnce();
    // Past the open period, the held breaker is still open, and the next check is not due yet.
    await t.clock.advance(OPEN_MS * 2);
    expect(t.breaker.state).toBe('open');
    await t.checker.checkOpen();
    expect(t.chat).toHaveBeenCalledOnce();

    await t.clock.advance(CHAT_INTERVAL_MS);
    await t.checker.checkOpen();
    expect(t.chat).toHaveBeenCalledTimes(2);
    expect(t.breaker.state).toBe('open');
  });

  it('starts a cooldown when the check gets a 429', async () => {
    const t = setup(() =>
      Promise.reject(
        new ProviderError('rate_limited', 'upstream status 429', { retryAfterMs: 7_000 }),
      ),
    );
    await t.checker.checkOpen();
    expect(t.quotas.cooldown).toHaveBeenCalledWith('listed', 7_000);
    expect(t.breaker.state).toBe('open');
  });

  it('is skipped while the quota is used up, and then does not hold the breaker', async () => {
    const t = setup(answered, {
      ok: false,
      kind: 'quota',
      reason: 'quota, 50 of 50 requests today',
      retryAfterMs: 1_000,
    });
    await t.checker.checkOpen();
    expect(t.chat).not.toHaveBeenCalled();
    await t.clock.advance(OPEN_MS);
    expect(t.breaker.state).toBe('half_open');
  });
});

describe('HealthChecker chat check backoff', () => {
  const MIN = 60_000;
  /** Every wait below is a whole number of ticks. */
  const TICK = 15_000;

  it('waits 1, 2, 4, 8 minutes and so on up to an hour while checks fail, and starts over after a pass', async () => {
    let healthy = false;
    const t = setup(() =>
      healthy ? answered() : Promise.reject(new ProviderError('not_found', 'upstream status 404')),
    );
    const sentAt: number[] = [];
    /** One tick: the checker runs, and records when a chat check is sent. */
    const tick = async (traffic: boolean) => {
      await t.clock.advance(TICK);
      // Traffic: a half-open breaker's trial request fails, as the deployment still does.
      if (traffic && t.breaker.state === 'half_open' && t.breaker.tryAcquire()) {
        t.breaker.onFailure('not_found');
      }
      const before = t.chat.mock.calls.length;
      await t.checker.checkOpen();
      if (t.chat.mock.calls.length > before) sentAt.push(t.clock.now());
    };
    const run = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK) await tick(true);
    };
    const gaps = () => sentAt.slice(1).map((at, i) => (at - sentAt[i]!) / MIN);

    await run(190 * MIN);
    expect(gaps().slice(0, 8)).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
    expect(t.breaker.state).toBe('open');

    // The deployment recovers: the next check passes and half-opens the breaker.
    healthy = true;
    sentAt.length = 0;
    while (sentAt.length === 0) await tick(false);
    expect(t.breaker.state).toBe('half_open');

    // It fails again: the interval has started over, a minute after the pass, then 1 and 2.
    healthy = false;
    t.breaker.tryAcquire();
    t.breaker.onFailure('not_found');
    await run(5 * MIN);
    expect(gaps()).toEqual([1, 1, 2]);
  }, 30_000);
});
