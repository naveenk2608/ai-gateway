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
    expect(t.quotas.acquire).toHaveBeenCalledWith(expect.objectContaining({ id: 'listed' }), 9);
    expect(t.quotas.settle).toHaveBeenCalledWith(null, 7, 8);
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
