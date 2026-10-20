import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@ai-gateway/shared';
import { closeRedis } from '@ai-gateway/shared/node';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ConsumerSettings } from '../src/config.js';
import { SimulatedCrash, type UsageConsumer } from '../src/consumer.js';
import { createUsageConsumer } from '../src/worker.js';
import {
  captureLogger,
  connect,
  createProject,
  isolatedSettings,
  makeEvent,
  pendingCount,
  publish,
} from './fixtures.js';

const { pool, db, redis } = connect();
const running: { consumer: UsageConsumer; close(): Promise<void> }[] = [];

afterAll(async () => {
  for (const r of running) {
    await r.consumer.stop();
    await r.close();
  }
  await closeRedis(redis);
  await pool.end();
});

async function startConsumer(
  settings: ConsumerSettings,
  faults?: Parameters<typeof createUsageConsumer>[0]['faults'],
) {
  const created = createUsageConsumer({
    settings,
    redisUrl: process.env.REDIS_URL!,
    db,
    logger: captureLogger().logger,
    faults,
  });
  running.push(created);
  await created.consumer.start();
  return created.consumer;
}

function usageRows(requestIds: string[]) {
  return db
    .selectFrom('usage_events')
    .select(['request_id', 'event_id', 'cost_micro_usd', 'price_id'])
    .where('request_id', 'in', requestIds)
    .execute();
}

describe('usage consumer', () => {
  it('turns the same event published 3 times into one usage row', async () => {
    const settings = isolatedSettings();
    const consumer = await startConsumer(settings);
    const event = makeEvent({ projectId: await createProject(db) });
    const payload = JSON.stringify(event);
    for (let i = 0; i < 3; i++) await publish(redis, settings.EVENTS_STREAM, payload);

    await vi.waitFor(() => expect(consumer.stats.processed).toBe(3), { timeout: 10_000 });
    expect(await usageRows([event.request.id])).toHaveLength(1);
    const records = await db
      .selectFrom('request_records')
      .select(['id', 'attempt_count', 'status'])
      .where('id', '=', event.request.id)
      .execute();
    expect(records).toEqual([{ id: event.request.id, attempt_count: 1, status: 'success' }]);
    const attempts = await db
      .selectFrom('provider_attempts')
      .select('id')
      .where('request_id', '=', event.request.id)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(await pendingCount(redis, settings)).toBe(0);
  });

  it.each(['before-commit', 'after-commit'] as const)(
    'a worker killed mid-batch (%s) loses no events and duplicates none after a restart',
    async (point) => {
      const settings = isolatedSettings({ WORKER_BATCH_SIZE: 50 });
      const projectId = await createProject(db);
      const events = Array.from({ length: 30 }, () => makeEvent({ projectId }));
      const ids = events.map((e) => e.request.id);
      for (const e of events) await publish(redis, settings.EVENTS_STREAM, JSON.stringify(e));

      // The first worker dies inside its first batch, before acknowledging anything.
      const doomed = await startConsumer(settings, {
        crash: (at) => {
          if (at === point) throw new SimulatedCrash(at);
        },
      });
      await doomed.done;
      expect(doomed.stats.processed).toBe(0);
      expect(await pendingCount(redis, settings)).toBe(30);
      // Rolled back before the commit; committed but unacknowledged after it.
      expect(await usageRows(ids)).toHaveLength(point === 'before-commit' ? 0 : 30);

      // A restarted worker claims the dead one's entries once they have been idle long enough.
      const restarted = await startConsumer(settings);
      await vi.waitFor(async () => expect(await pendingCount(redis, settings)).toBe(0), {
        timeout: 10_000,
        interval: 100,
      });
      expect(restarted.stats.reclaimed).toBe(30);
      const rows = await usageRows(ids);
      expect(rows).toHaveLength(30);
      expect(new Set(rows.map((r) => r.request_id))).toEqual(new Set(ids));
    },
  );

  it('dead-letters malformed events after repeated deliveries without blocking the others', async () => {
    const settings = isolatedSettings({ WORKER_MAX_DELIVERIES: 5, WORKER_CLAIM_IDLE_MS: 100 });
    const projectId = await createProject(db);
    const good = [makeEvent({ projectId }), makeEvent({ projectId })];
    const notJson = await publish(redis, settings.EVENTS_STREAM, '{"v": 1, broken');
    await publish(redis, settings.EVENTS_STREAM, JSON.stringify(good[0]));
    const badSchema = await publish(
      redis,
      settings.EVENTS_STREAM,
      JSON.stringify({ ...makeEvent({ projectId }), usageSource: 'guessed' }),
    );
    await publish(redis, settings.EVENTS_STREAM, JSON.stringify(good[1]));

    const consumer = await startConsumer(settings);
    // The good events are stored straight away, while the bad ones are still being retried.
    await vi.waitFor(async () =>
      expect(await usageRows(good.map((e) => e.request.id))).toHaveLength(2),
    );
    const early = await db
      .selectFrom('failed_events')
      .select('id')
      .where('stream', '=', settings.EVENTS_STREAM)
      .execute();
    expect(early).toEqual([]);

    await vi.waitFor(() => expect(consumer.stats.deadLettered).toBe(2), {
      timeout: 15_000,
      interval: 100,
    });
    const failed = await db
      .selectFrom('failed_events')
      .select(['stream_message_id', 'error', 'delivery_count', 'payload'])
      .where('stream', '=', settings.EVENTS_STREAM)
      .orderBy('stream_message_id')
      .execute();
    expect(failed).toEqual([
      {
        stream_message_id: notJson,
        error: 'event is not valid JSON',
        delivery_count: 6,
        payload: '{"v": 1, broken',
      },
      {
        stream_message_id: badSchema,
        error: expect.stringMatching(/^usageSource: /) as string,
        delivery_count: 6,
        payload: expect.any(String) as string,
      },
    ]);
    const dlq = (await redis.call('XRANGE', settings.EVENTS_DLQ_STREAM, '-', '+')) as [
      string,
      string[],
    ][];
    expect(dlq.map(([, fields]) => fields[fields.indexOf('source_id') + 1])).toEqual([
      notJson,
      badSchema,
    ]);
    expect(await pendingCount(redis, settings)).toBe(0);
  });

  it('costs each request with the price in effect when it started, so price changes leave past costs alone', async () => {
    const settings = isolatedSettings();
    const consumer = await startConsumer(settings);
    const projectId = await createProject(db);
    const provider = `prov-${randomBytes(3).toString('hex')}`;
    const model = 'priced-model';
    const t0 = Date.UTC(2026, 5, 1);
    const hour = 3_600_000;
    const insertPrice = async (input: number, output: number, from: number) => {
      const id = uuidv7();
      await db
        .insertInto('model_prices')
        .values({
          id,
          provider,
          model,
          input_micro_usd_per_mtok: input,
          output_micro_usd_per_mtok: output,
          effective_from: new Date(from),
        })
        .execute();
      return id;
    };
    const send = async (startedAt: number) => {
      const event = makeEvent({
        projectId,
        provider,
        providerModel: model,
        startedAt: new Date(startedAt),
      });
      await publish(redis, settings.EVENTS_STREAM, JSON.stringify(event));
      return event.request.id;
    };
    const costOf = async (requestId: string) => {
      await vi.waitFor(async () => expect(await usageRows([requestId])).toHaveLength(1));
      return (await usageRows([requestId]))[0]!;
    };

    // 1,000 prompt + 500 completion tokens.
    const v1 = await insertPrice(150_000, 600_000, t0); // 150 + 300 = 450 micro-dollars
    const a = await send(t0 + hour);
    expect(await costOf(a)).toMatchObject({ cost_micro_usd: 450, price_id: v1 });

    const v2 = await insertPrice(300_000, 1_200_000, t0 + 2 * hour); // 900 micro-dollars
    const b = await send(t0 + 3 * hour);
    // A late event for a request that started before the change still gets the old price.
    const c = await send(t0 + 1.5 * hour);
    expect(await costOf(b)).toMatchObject({ cost_micro_usd: 900, price_id: v2 });
    expect(await costOf(c)).toMatchObject({ cost_micro_usd: 450, price_id: v1 });
    // The first request's cost is unchanged.
    expect(await costOf(a)).toMatchObject({ cost_micro_usd: 450, price_id: v1 });
    // And a price version itself cannot be edited.
    await expect(
      db
        .updateTable('model_prices')
        .set({ input_micro_usd_per_mtok: 1 })
        .where('id', '=', v1)
        .execute(),
    ).rejects.toThrow(/immutable/);
    expect(consumer.stats.deadLettered).toBe(0);
  });

  it('stores no cost when no price is known, and none for missing usage', async () => {
    const settings = isolatedSettings();
    await startConsumer(settings);
    const projectId = await createProject(db);
    const unpriced = makeEvent({ projectId, provider: `none-${randomBytes(3).toString('hex')}` });
    const missing = makeEvent({ projectId, usage: null });
    for (const e of [unpriced, missing]) {
      await publish(redis, settings.EVENTS_STREAM, JSON.stringify(e));
    }
    await vi.waitFor(async () =>
      expect(await usageRows([unpriced.request.id, missing.request.id])).toHaveLength(2),
    );
    const rows = await db
      .selectFrom('usage_events')
      .select(['request_id', 'usage_source', 'total_tokens', 'cost_micro_usd'])
      .where('request_id', 'in', [unpriced.request.id, missing.request.id])
      .execute();
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          request_id: unpriced.request.id,
          usage_source: 'reported',
          total_tokens: 1_500,
          cost_micro_usd: null,
        },
        {
          request_id: missing.request.id,
          usage_source: 'missing',
          total_tokens: null,
          cost_micro_usd: null,
        },
      ]),
    );
  });

  it('trims acknowledged entries from the stream', async () => {
    const settings = isolatedSettings({ WORKER_TRIM_INTERVAL_MS: 100 });
    const consumer = await startConsumer(settings);
    const projectId = await createProject(db);
    for (let i = 0; i < 5; i++) {
      await publish(redis, settings.EVENTS_STREAM, JSON.stringify(makeEvent({ projectId })));
    }
    await vi.waitFor(() => expect(consumer.stats.processed).toBe(5));
    // MINID trimming keeps the last delivered entry; approximate trimming may keep a few more,
    // but on a stream this short Redis trims exactly.
    await vi.waitFor(async () =>
      expect(Number(await redis.call('XLEN', settings.EVENTS_STREAM))).toBeLessThanOrEqual(1),
    );
  });
});
