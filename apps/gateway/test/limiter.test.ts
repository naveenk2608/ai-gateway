import { randomBytes } from 'node:crypto';
import { ManualClock, uuidv7 } from '@ai-gateway/shared';
import { closeRedis, createRedis, type Redis } from '@ai-gateway/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Limiter, type AdmitRequest, type Ticket } from '../src/limits/limiter.js';
import { NO_SCOPE_LIMITS, UNLIMITED, type UsagePolicy } from '../src/limits/policy.js';
import { captureLogger, sleepsQueued } from './helpers.js';

const LEASE_TTL = 30_000;
let redis: Redis;

beforeAll(async () => {
  redis = createRedis(process.env.REDIS_URL!, captureLogger().logger);
  // Commands fail at once while disconnected (no offline queue), so wait for the connection.
  await new Promise((resolve) => redis.once('ready', resolve));
});

afterAll(async () => {
  await closeRedis(redis);
});

/** A limiter with its own key prefix and clock, and a stand-in for the Postgres spend ledger. */
function setup(spend = 0) {
  const clock = new ManualClock(Date.UTC(2026, 9, 20, 12));
  const prefix = `test:lim:${randomBytes(4).toString('hex')}:`;
  const ledger = { spend, loads: 0 };
  const limiter = new Limiter({
    redis,
    clock,
    logger: captureLogger().logger,
    leaseTtlMs: LEASE_TTL,
    prefix,
    loadSpend: () => {
      ledger.loads++;
      return Promise.resolve(ledger.spend);
    },
  });
  const projectId = uuidv7();
  const request = (policy: Partial<UsagePolicy>, extra: Partial<AdmitRequest> = {}) => ({
    requestId: uuidv7(),
    projectId,
    apiKeyId: extra.apiKeyId ?? 'key-a',
    policy: { ...UNLIMITED, ...policy },
    tokens: 0,
    costMicroUsd: 0,
    ...extra,
  });
  const admitted = async (policy: Partial<UsagePolicy>, extra: Partial<AdmitRequest> = {}) => {
    const result = await limiter.admit(request(policy, extra));
    if (!result.admitted) throw new Error(`rejected: ${result.rejection.reason}`);
    return result.ticket;
  };
  const rejection = async (policy: Partial<UsagePolicy>, extra: Partial<AdmitRequest> = {}) => {
    const result = await limiter.admit(request(policy, extra));
    if (result.admitted) throw new Error('admitted');
    return result.rejection;
  };
  return { clock, prefix, ledger, limiter, projectId, admitted, rejection };
}

const settle = (ticket: Ticket, tokens = 0, costMicroUsd = 0) =>
  ticket.settle({ tokens, costMicroUsd });

describe('requests per minute (token bucket)', () => {
  it('admits the limit, then rejects until a token refills', async () => {
    const t = setup();
    const policy = { key: { ...NO_SCOPE_LIMITS, rpm: 3 } };
    for (let i = 0; i < 3; i++) await t.admitted(policy);
    expect(await t.rejection(policy)).toEqual({
      reason: 'rpm',
      scope: 'key',
      retryAfterMs: 20_000,
    });
    await t.clock.advance(20_000);
    await t.admitted(policy);
    expect((await t.rejection(policy)).reason).toBe('rpm');
  });

  it('counts every key of a project against the project limit', async () => {
    const t = setup();
    const policy = { project: { ...NO_SCOPE_LIMITS, rpm: 2 } };
    await t.admitted(policy, { apiKeyId: 'key-a' });
    await t.admitted(policy, { apiKeyId: 'key-b' });
    expect(await t.rejection(policy, { apiKeyId: 'key-c' })).toMatchObject({
      reason: 'rpm',
      scope: 'project',
    });
  });

  it('takes nothing from a request another limit rejects', async () => {
    const t = setup();
    const policy = {
      key: { ...NO_SCOPE_LIMITS, rpm: 3 },
      project: { ...NO_SCOPE_LIMITS, concurrency: 1 },
    };
    const first = await t.admitted(policy);
    for (let i = 0; i < 5; i++) expect((await t.rejection(policy)).reason).toBe('concurrency');
    await settle(first);
    // Only the first request used an RPM token.
    await settle(await t.admitted(policy));
    await settle(await t.admitted(policy));
    expect((await t.rejection(policy)).reason).toBe('rpm');
  });
});

describe('tokens per minute (reserve, then reconcile)', () => {
  const policy = { key: { ...NO_SCOPE_LIMITS, tpm: 100 } };

  it('reserves the estimate and gives back what the request did not use', async () => {
    const t = setup();
    const first = await t.admitted(policy, { tokens: 60 });
    // 40 left; 60 more need 20 tokens, which refill in 12 s.
    expect(await t.rejection(policy, { tokens: 60 })).toEqual({
      reason: 'tpm',
      scope: 'key',
      retryAfterMs: 12_000,
    });
    await settle(first, 10);
    await t.admitted(policy, { tokens: 60 });
  });

  it('takes the overshoot when a request used more than it reserved', async () => {
    const t = setup();
    await settle(await t.admitted(policy, { tokens: 50 }), 90);
    // 100 - 90 = 10 left.
    expect((await t.rejection(policy, { tokens: 20 })).retryAfterMs).toBe(6_000);
  });

  it('never admits a request larger than the limit', async () => {
    const t = setup();
    expect(await t.rejection(policy, { tokens: 101 })).toEqual({
      reason: 'tpm',
      scope: 'key',
      retryAfterMs: null,
    });
  });
});

describe('concurrency (lease set)', () => {
  const policy = { project: { ...NO_SCOPE_LIMITS, concurrency: 2 } };

  it('admits up to the limit and frees a slot when a request settles', async () => {
    const t = setup();
    const first = await t.admitted(policy);
    await t.admitted(policy);
    expect(await t.rejection(policy)).toMatchObject({ reason: 'concurrency', scope: 'project' });
    await settle(first);
    await t.admitted(policy);
  });

  it('admits exactly the limit out of many simultaneous requests', async () => {
    const t = setup();
    const limited = { project: { ...NO_SCOPE_LIMITS, concurrency: 10 } };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        t.limiter.admit({
          requestId: uuidv7(),
          projectId: t.projectId,
          apiKeyId: `key-${i % 5}`,
          policy: { ...UNLIMITED, ...limited },
          tokens: 0,
          costMicroUsd: 0,
        }),
      ),
    );
    expect(results.filter((r) => r.admitted)).toHaveLength(10);
  });

  it("frees a crashed request's slot when its lease expires", async () => {
    const t = setup();
    const single = { project: { ...NO_SCOPE_LIMITS, concurrency: 1 } };
    (await t.admitted(single)).abandon();
    await t.clock.advance(LEASE_TTL - 1);
    expect((await t.rejection(single)).reason).toBe('concurrency');
    await t.clock.advance(2);
    await t.admitted(single);
  });

  it('keeps the lease of a long request alive while it renews', async () => {
    const t = setup();
    const single = { project: { ...NO_SCOPE_LIMITS, concurrency: 1 } };
    const running = await t.admitted(single);
    running.keepAlive();
    for (let i = 0; i < 9; i++) {
      await sleepsQueued(t.clock, 1);
      await t.clock.advance(LEASE_TTL / 3);
    }
    // Three TTLs later the slot is still held.
    await vi.waitFor(async () => expect((await t.rejection(single)).reason).toBe('concurrency'));
    await settle(running);
    await t.admitted(single);
  });
});

describe('budgets (reserve worst case, reconcile to actual)', () => {
  const budget = (limit: number) => ({ monthlyBudgetMicroUsd: limit });

  it('admits while spend plus reservations fit, and charges the actual cost', async () => {
    const t = setup();
    const first = await t.admitted(budget(100), { costMicroUsd: 40 });
    await t.admitted(budget(100), { costMicroUsd: 40 });
    const rejected = await t.rejection(budget(100), { costMicroUsd: 40 });
    expect(rejected).toMatchObject({ reason: 'budget', scope: 'project' });
    // Until the month ends: 20 October 12:00 to 1 November.
    expect(rejected.retryAfterMs).toBe(Date.UTC(2026, 10, 1) - Date.UTC(2026, 9, 20, 12));
    expect(await settle(first, 0, 10)).toBe(true);
    // Spent 10, reserved 40: 40 more fits in 100.
    await t.admitted(budget(100), { costMicroUsd: 40 });
  });

  it('rebuilds missing totals from Postgres instead of starting from zero', async () => {
    const t = setup(70);
    expect((await t.rejection(budget(100), { costMicroUsd: 40 })).reason).toBe('budget');
    expect(t.ledger.loads).toBe(1);
    await t.admitted(budget(100), { costMicroUsd: 30 });
    // Totals now live in Redis; Postgres is not asked again.
    expect(t.ledger.loads).toBe(1);

    // Redis restarts empty (as Render's free Redis does): totals come back from the ledger.
    await redis.del(`${t.prefix}budget:${t.projectId}:2026-10`);
    t.ledger.spend = 20;
    await t.admitted(budget(100), { costMicroUsd: 40 });
    expect(t.ledger.loads).toBe(2);
  });

  it('never admits a request that costs more than the whole budget', async () => {
    const t = setup();
    expect(await t.rejection(budget(100), { costMicroUsd: 101 })).toEqual({
      reason: 'budget',
      scope: 'project',
      retryAfterMs: null,
    });
  });

  it("sweeps a crashed request's reservation once, after its lease expires", async () => {
    const t = setup();
    (await t.admitted(budget(100), { costMicroUsd: 60 })).abandon();
    expect((await t.rejection(budget(100), { costMicroUsd: 60 })).reason).toBe('budget');
    expect(await t.limiter.sweep()).toEqual([]);

    await t.clock.advance(LEASE_TTL + 1);
    const [expired, ...rest] = await t.limiter.sweep();
    expect(rest).toEqual([]);
    expect(expired).toMatchObject({
      projectId: t.projectId,
      period: '2026-10',
      amountMicroUsd: 60,
    });
    expect(await t.limiter.sweep()).toEqual([]);
    await t.admitted(budget(100), { costMicroUsd: 60 });
  });

  it('charges a request that settles after its reservation was swept', async () => {
    const t = setup();
    const slow = await t.admitted(budget(100), { costMicroUsd: 60 });
    await t.clock.advance(LEASE_TTL + 1);
    expect(await t.limiter.sweep()).toHaveLength(1);
    expect(await settle(slow, 0, 50)).toBe(true);
    // Spent 50, nothing reserved.
    await t.admitted(budget(100), { costMicroUsd: 50 });
    expect((await t.rejection(budget(100), { costMicroUsd: 1 })).reason).toBe('budget');
  });
});
