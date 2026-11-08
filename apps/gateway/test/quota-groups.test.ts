import { randomBytes } from 'node:crypto';
import { ManualClock } from '@ai-gateway/shared';
import { closeRedis, createRedis, type Redis } from '@ai-gateway/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QuotaBoard, type QuotaGroupShare, type QuotaTarget } from '../src/routing/quota.js';
import { captureLogger } from './helpers.js';

// Quota groups (ADR 025, note of 2026-11-08) against a real Redis: an allowance shared by several
// deployments of one account, counted with the Lua script that counts each deployment's own quota.
let redis: Redis;

beforeAll(async () => {
  redis = createRedis(process.env.REDIS_URL!, captureLogger().logger);
  // Commands fail at once while disconnected (no offline queue), so wait for the connection.
  await new Promise((resolve) => redis.once('ready', resolve));
});

afterAll(async () => {
  await closeRedis(redis);
});

function board(clock: ManualClock, client: Redis = redis) {
  return new QuotaBoard({
    redis: client,
    clock,
    logger: captureLogger().logger,
    defaultCooldownMs: 30_000,
    prefix: `test:qg:${randomBytes(4).toString('hex')}:`,
  });
}

/** A group of 10,000 units a day with Cloudflare-like rates: 24,545 and 77,273 per M tokens. */
function members(): { chat: QuotaTarget; embed: QuotaTarget } {
  const group = { id: 'shared', unit: 'neurons', perDay: 10_000 };
  const chat: QuotaGroupShare = {
    ...group,
    perRequest: 0,
    perMillionInputTokens: 24_545,
    perMillionOutputTokens: 77_273,
  };
  const embed: QuotaGroupShare = {
    ...group,
    perRequest: 0,
    perMillionInputTokens: 18_582,
    perMillionOutputTokens: 0,
  };
  return {
    chat: { id: 'chat-a', quota: { requestsPerMinute: 300 }, quotaGroup: chat },
    embed: { id: 'embed-b', quota: null, quotaGroup: embed },
  };
}

describe('quota groups', () => {
  it('stops every deployment of a group together when the shared allowance runs out', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 8, 10, 0, 0));
    const quotas = board(clock);
    const { chat, embed } = members();
    // 1,000 input tokens and a 100,000-token output cap: ceil(24.545 + 7,727.3) = 7,752 neurons.
    const big = await quotas.acquire(chat, { input: 1_000, output: 100_000 });
    expect(big.ok).toBe(true);
    // 100,000 input tokens of embeddings: ceil(1,858.2) = 1,859 neurons, 9,611 in all.
    expect((await quotas.acquire(embed, { input: 100_000, output: 0 })).ok).toBe(true);
    // Another 30,000 embedding tokens (558 neurons) would pass 10,000: both members are refused.
    const refusedEmbed = await quotas.acquire(embed, { input: 30_000, output: 0 });
    expect(refusedEmbed).toMatchObject({
      ok: false,
      kind: 'quota',
      reason: 'quota group shared, 9,611 of 10,000 neurons today',
    });
    // A chat try of 100 input and 6,000 output tokens: ceil(2.4545 + 463.638) = 467 neurons.
    const refusedChat = await quotas.acquire(chat, { input: 100, output: 6_000 });
    expect(refusedChat).toMatchObject({ ok: false, kind: 'quota' });
    expect(refusedChat.ok ? '' : refusedChat.reason).toMatch(
      /^quota group shared, 9,611 of 10,000/,
    );
    // Until the UTC day ends.
    expect(refusedChat.ok ? 0 : refusedChat.retryAfterMs).toBe(14 * 3_600_000);
  });

  it('corrects a reservation to the tokens the try reported', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 8, 10, 0, 0));
    const quotas = board(clock);
    const { chat, embed } = members();
    const first = await quotas.acquire(chat, { input: 1_000, output: 100_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // It used 1,000 input and 200 output tokens: ceil(24.545 + 15.4546) = 40 neurons, not 7,752.
    quotas.settle(
      first.ticket,
      { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
      1_000,
    );
    // So 9,960 neurons are left: 500,000 embedding tokens (9,291 neurons) now fit, which they
    // would not before the correction (a refusal counts nothing, so it can be asked again).
    await vi.waitFor(async () => {
      expect((await quotas.acquire(embed, { input: 500_000, output: 0 })).ok).toBe(true);
    });
    // And its own token count was corrected too (the deployment quota still counts requests).
    await vi.waitFor(async () => {
      const usage = await quotas.usage([chat]);
      expect(usage[0]).toMatchObject({ minute: { requests: 1, tokens: 1_200 } });
    });
  });

  it('lets every deployment be tried when Redis does not answer', async () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 8, 10, 0, 0));
    // Nothing listens on port 1; the client keeps no offline queue, so each call fails at once.
    const down = createRedis('redis://127.0.0.1:1', captureLogger().logger);
    down.on('error', () => undefined);
    try {
      const quotas = board(clock, down);
      const { chat, embed } = members();
      for (const target of [chat, embed]) {
        expect(await quotas.acquire(target, { input: 1_000_000, output: 1_000_000 })).toEqual({
          ok: true,
          ticket: null,
        });
      }
    } finally {
      down.disconnect();
    }
  });
});
