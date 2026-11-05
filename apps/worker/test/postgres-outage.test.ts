import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import { createDb, createPgPool } from '@ai-gateway/shared/node';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createTestQueues,
  LOCALSTACK_REGION,
  LOCALSTACK_URL,
  localstackAvailable,
  type TestQueues,
} from '../../../test/localstack.js';
import type { EventConsumer } from '../src/consumer.js';
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

const sqsAvailable = await localstackAvailable();

/**
 * Postgres behind a TCP proxy the test switches off and on: while it is off, every connection is
 * cut at once, as when the database restarts or the network drops.
 */
async function switchablePostgres() {
  const target = new URL(process.env.DATABASE_URL!);
  const sockets = new Set<Socket>();
  let up = false;
  const server: Server = createServer((client) => {
    if (!up) {
      client.destroy();
      return;
    }
    const upstream = tcpConnect(Number(target.port || 5432), target.hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(s);
      });
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as { port: number }).port);
  return {
    url: url.toString(),
    set(next: boolean) {
      up = next;
      if (!next) for (const s of sockets) s.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const { pool, db, redis } = connect();
const cleanup: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const c of cleanup.reverse()) await c();
  redis.disconnect();
  await pool.end();
});

/** A consumer whose database is the switchable proxy. */
async function consumerOnProxy(
  settings: Parameters<typeof createUsageConsumer>[0]['settings'],
  proxyUrl: string,
) {
  const { logger, lines } = captureLogger();
  const proxyPool = createPgPool(proxyUrl, logger, { max: 2 });
  const created = createUsageConsumer({
    settings,
    redisUrl: process.env.REDIS_URL,
    db: createDb(proxyPool),
    logger,
  });
  cleanup.push(async () => {
    await created.consumer.stop();
    await created.close();
    await proxyPool.end();
  });
  await created.consumer.start();
  return { consumer: created.consumer, lines };
}

const retrying = (lines: { msg?: string }[]) =>
  lines.some((l) => l.msg === 'postgres unavailable, retrying batch');

function usageRows(requestIds: string[]) {
  return db
    .selectFrom('usage_events')
    .select('request_id')
    .where('request_id', 'in', requestIds)
    .execute();
}

describe('Postgres unavailable', () => {
  it('the Redis consumer holds its batch until Postgres is back, then stores it once', async () => {
    const pg = await switchablePostgres();
    cleanup.push(pg.close);
    const settings = isolatedSettings({ WORKER_CLAIM_IDLE_MS: 60_000 });
    const events = Array.from({ length: 3 }, async () =>
      makeEvent({ projectId: await createProject(db) }),
    );
    const ready = await Promise.all(events);
    for (const e of ready) await publish(redis, settings.EVENTS_STREAM, JSON.stringify(e));

    const { consumer, lines } = await consumerOnProxy(settings, pg.url);
    await vi.waitFor(() => expect(retrying(lines)).toBe(true), { timeout: 10_000 });
    expect(await pendingCount(redis, settings)).toBe(3);
    expect(await usageRows(ready.map((e) => e.request.id))).toHaveLength(0);

    pg.set(true);
    await vi.waitFor(() => expect(consumer.stats.processed).toBe(3), { timeout: 20_000 });
    expect(await usageRows(ready.map((e) => e.request.id))).toHaveLength(3);
    expect(await pendingCount(redis, settings)).toBe(0);
    expect(consumer.stats.deadLettered).toBe(0);
  });

  it('two Redis consumers: an outage longer than deliveries x claim idle time dead-letters nothing', async () => {
    const pg = await switchablePostgres();
    cleanup.push(pg.close);
    // A 1 s claim idle time, one delivery allowed, and an outage of 4 s: if the second worker's
    // XAUTOCLAIM took the batch the first one is retrying, that second delivery would send valid
    // events to the dead-letter stream.
    const settings = isolatedSettings({
      WORKER_BLOCK_MS: 1_000,
      WORKER_CLAIM_IDLE_MS: 1_000,
      WORKER_MAX_DELIVERIES: 1,
    });
    const ready = await Promise.all(
      Array.from({ length: 3 }, async () => makeEvent({ projectId: await createProject(db) })),
    );
    for (const e of ready) await publish(redis, settings.EVENTS_STREAM, JSON.stringify(e));

    const first = await consumerOnProxy(settings, pg.url);
    await vi.waitFor(() => expect(retrying(first.lines)).toBe(true), { timeout: 10_000 });
    const second = await consumerOnProxy(settings, pg.url);
    // Several claim idle times pass while Postgres is down.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(await pendingCount(redis, settings)).toBe(3);

    pg.set(true);
    const ids = ready.map((e) => e.request.id);
    await vi.waitFor(async () => expect(await usageRows(ids)).toHaveLength(3), {
      timeout: 20_000,
    });
    await vi.waitFor(async () => expect(await pendingCount(redis, settings)).toBe(0), {
      timeout: 20_000,
    });
    // The first worker kept its batch: the second never claimed it, so nothing was delivered
    // twice, and nothing reached the dead-letter stream.
    const all: EventConsumer[] = [first.consumer, second.consumer];
    expect(all.map((c) => c.stats.reclaimed)).toEqual([0, 0]);
    expect(all.map((c) => c.stats.deadLettered)).toEqual([0, 0]);
    expect(first.consumer.stats.processed).toBe(3);
    expect(second.consumer.stats.processed).toBe(0);
  });

  it.skipIf(!sqsAvailable)(
    'the SQS consumer keeps its batch hidden from other workers until Postgres is back (LocalStack)',
    async () => {
      const pg = await switchablePostgres();
      cleanup.push(pg.close);
      const q: TestQueues = await createTestQueues();
      cleanup.push(() => q.remove());
      // A 1 s visibility timeout and an outage several times longer: without extending the
      // batch's visibility, the second worker would receive it.
      const settings = isolatedSettings({
        EVENT_BUS: 'sqs',
        SQS_QUEUE_URL: q.queueUrl,
        SQS_DLQ_URL: q.dlqUrl,
        AWS_REGION: LOCALSTACK_REGION,
        SQS_ENDPOINT: LOCALSTACK_URL,
        WORKER_BLOCK_MS: 1_000,
        WORKER_CLAIM_IDLE_MS: 1_000,
        WORKER_MAX_DELIVERIES: 2,
      });
      const ready = await Promise.all(
        Array.from({ length: 3 }, async () => makeEvent({ projectId: await createProject(db) })),
      );
      await q.sqs.sendBatch(
        q.queueUrl,
        ready.map((e) => JSON.stringify(e)),
      );

      const first = await consumerOnProxy(settings, pg.url);
      await vi.waitFor(() => expect(retrying(first.lines)).toBe(true), { timeout: 10_000 });
      const second = await consumerOnProxy(settings, pg.url);
      // Several visibility timeouts pass while Postgres is down.
      await new Promise((resolve) => setTimeout(resolve, 4_000));

      pg.set(true);
      await vi.waitFor(
        () => expect(first.consumer.stats.processed + second.consumer.stats.processed).toBe(3),
        { timeout: 20_000 },
      );
      expect(await usageRows(ready.map((e) => e.request.id))).toHaveLength(3);
      // Nobody else got the batch, so nothing was delivered twice or dead-lettered.
      const all: EventConsumer[] = [first.consumer, second.consumer];
      expect(all.map((c) => c.stats.reclaimed)).toEqual([0, 0]);
      expect(all.map((c) => c.stats.deadLettered)).toEqual([0, 0]);
      expect(second.consumer.stats.processed).toBe(0);
    },
  );
});
