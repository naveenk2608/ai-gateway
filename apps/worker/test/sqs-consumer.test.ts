import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createTestQueues,
  LOCALSTACK_REGION,
  LOCALSTACK_URL,
  localstackAvailable,
  type TestQueues,
} from '../../../test/localstack.js';
import type { ConsumerSettings } from '../src/config.js';
import { SimulatedCrash, type EventConsumer } from '../src/consumer.js';
import { readSqsPipelineState } from '../src/pipeline.js';
import { createUsageConsumer } from '../src/worker.js';
import { captureLogger, connect, createProject, isolatedSettings, makeEvent } from './fixtures.js';

// Against LocalStack (`docker compose --profile aws-local up -d`); skipped when it is not running.
const available = await localstackAvailable();

const { pool, db, redis } = connect();
const running: { consumer: EventConsumer; close(): Promise<void> }[] = [];
const queues: TestQueues[] = [];

afterAll(async () => {
  for (const r of running) {
    await r.consumer.stop();
    await r.close();
  }
  for (const q of queues) await q.remove();
  redis.disconnect();
  await pool.end();
});

async function sqsSettings(
  overrides: Partial<ConsumerSettings> = {},
): Promise<{ settings: ConsumerSettings; q: TestQueues }> {
  const q = await createTestQueues();
  queues.push(q);
  const settings = isolatedSettings({
    EVENT_BUS: 'sqs',
    SQS_QUEUE_URL: q.queueUrl,
    SQS_DLQ_URL: q.dlqUrl,
    AWS_REGION: LOCALSTACK_REGION,
    SQS_ENDPOINT: LOCALSTACK_URL,
    WORKER_BLOCK_MS: 1_000,
    // The visibility timeout: how soon a message left undeleted is delivered again.
    WORKER_CLAIM_IDLE_MS: 1_000,
    ...overrides,
  });
  return { settings, q };
}

async function startConsumer(
  settings: ConsumerSettings,
  faults?: Parameters<typeof createUsageConsumer>[0]['faults'],
) {
  const created = createUsageConsumer({ settings, db, logger: captureLogger().logger, faults });
  running.push(created);
  await created.consumer.start();
  return created.consumer;
}

async function stopConsumer(consumer: EventConsumer) {
  await consumer.stop();
}

function usageRows(requestIds: string[]) {
  return db
    .selectFrom('usage_events')
    .select(['request_id'])
    .where('request_id', 'in', requestIds)
    .execute();
}

async function queueEmpty(q: TestQueues) {
  const depth = await q.sqs.depth(q.queueUrl);
  return depth.visible + depth.inFlight + depth.delayed === 0;
}

describe.skipIf(!available)('SQS usage consumer (LocalStack)', () => {
  it('stores an event once, however many times SQS delivers it, and deletes the messages', async () => {
    const { settings, q } = await sqsSettings();
    const event = makeEvent({ projectId: await createProject(db) });
    const payload = JSON.stringify(event);
    expect(await q.sqs.sendBatch(q.queueUrl, [payload, payload, payload])).toEqual([]);

    const consumer = await startConsumer(settings);
    await vi.waitFor(() => expect(consumer.stats.processed).toBe(3), { timeout: 15_000 });
    expect(await usageRows([event.request.id])).toHaveLength(1);
    await vi.waitFor(async () => expect(await queueEmpty(q)).toBe(true), { timeout: 10_000 });
    await stopConsumer(consumer);
  });

  it.each(['before-commit', 'after-commit'] as const)(
    'a worker killed mid-batch (%s) loses no events and duplicates none',
    async (point) => {
      const { settings, q } = await sqsSettings({ WORKER_BATCH_SIZE: 50 });
      const projectId = await createProject(db);
      const events = Array.from({ length: 25 }, () => makeEvent({ projectId }));
      const ids = events.map((e) => e.request.id);
      expect(
        await q.sqs.sendBatch(
          q.queueUrl,
          events.map((e) => JSON.stringify(e)),
        ),
      ).toEqual([]);

      // The first worker dies inside its first batch, deleting nothing.
      const doomed = await startConsumer(settings, {
        crash: (at) => {
          if (at === point) throw new SimulatedCrash(at);
        },
      });
      await doomed.done;
      expect(doomed.stats.processed).toBe(0);
      expect(await usageRows(ids)).toHaveLength(point === 'before-commit' ? 0 : events.length);

      // The messages come back after the visibility timeout; a new worker stores them once.
      const restarted = await startConsumer(settings);
      await vi.waitFor(async () => expect(await queueEmpty(q)).toBe(true), {
        timeout: 20_000,
        interval: 250,
      });
      expect(restarted.stats.reclaimed).toBeGreaterThan(0);
      const rows = await usageRows(ids);
      expect(rows).toHaveLength(events.length);
      expect(new Set(rows.map((r) => r.request_id))).toEqual(new Set(ids));
      await stopConsumer(restarted);
    },
  );

  it('dead-letters a malformed event after repeated deliveries, without holding back the rest', async () => {
    const { settings, q } = await sqsSettings({ WORKER_MAX_DELIVERIES: 2 });
    const good = makeEvent({ projectId: await createProject(db) });
    await q.sqs.sendBatch(q.queueUrl, ['{"v": 1, broken', JSON.stringify(good)]);

    const consumer = await startConsumer(settings);
    await vi.waitFor(() => expect(consumer.stats.deadLettered).toBe(1), { timeout: 20_000 });
    expect(await usageRows([good.request.id])).toHaveLength(1);

    const failed = await db
      .selectFrom('failed_events')
      .select(['stream', 'payload', 'error', 'delivery_count', 'event_id'])
      .where('stream', '=', `sqs:${q.name}`)
      .execute();
    expect(failed).toEqual([
      {
        stream: `sqs:${q.name}`,
        payload: '{"v": 1, broken',
        error: 'event is not valid JSON',
        delivery_count: 3,
        event_id: null,
      },
    ]);
    // Moved to the dead-letter queue by the worker, then deleted from the usage queue.
    const [moved] = await q.sqs.receive(q.dlqUrl, {
      max: 10,
      waitSeconds: 1,
      visibilitySeconds: 30,
    });
    expect(moved?.body).toBe('{"v": 1, broken');
    await vi.waitFor(async () => expect(await queueEmpty(q)).toBe(true), { timeout: 10_000 });
    await stopConsumer(consumer);
  });

  it('reports the queues for the Infrastructure page and metrics', async () => {
    const { q } = await sqsSettings();
    await q.sqs.sendBatch(q.queueUrl, ['{}', '{}', '{}']);
    await q.sqs.send(q.dlqUrl, '{}');
    expect(await readSqsPipelineState(q.sqs, q)).toEqual({
      transport: 'sqs',
      streamLength: 3,
      unreadEvents: 3,
      pendingEvents: 0,
      oldestPendingAgeMs: null,
      consumers: null,
      deadLetterLength: 1,
    });
  });

  it('stops promptly while waiting on an empty queue', async () => {
    const { settings } = await sqsSettings({ WORKER_BLOCK_MS: 20_000 });
    const consumer = await startConsumer(settings);
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
