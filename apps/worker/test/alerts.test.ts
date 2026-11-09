import { randomBytes } from 'node:crypto';
import { ManualClock, uuidv7, type UsageEvent } from '@ai-gateway/shared';
import { alertsKey, sealText, type Db } from '@ai-gateway/shared/node';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeadLetterAlerts } from '../src/alerts/detect.js';
import { AlertDispatcher, RETRY_DELAYS_MS, type AlertSettings } from '../src/alerts/dispatcher.js';
import type { Resolver } from '../src/alerts/ssrf.js';
import type { Transport } from '../src/alerts/transport.js';
import { ingestEvents } from '../src/ingest.js';
import { captureLogger, connect, createProject, makeEvent } from './fixtures.js';

// Webhook alerts (M15, ADR 033) against Postgres: budget thresholds queued once each by the
// ingest transaction, and the dispatcher's retries, SSRF refusals and failures.
let pool: pg.Pool;
let db: Db;
const key = alertsKey({ API_KEY_PEPPER: 'test-pepper-for-alerts-0123456789abcdef' })!;
const model = `alerts-${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  ({ pool, db } = connect());
  // 1 micro-dollar per prompt token.
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model,
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 0,
      effective_from: new Date(0),
    })
    .execute();
});

afterAll(async () => {
  await pool.end();
});

async function destination(
  projectId: string,
  events: string[],
  url = 'https://hooks.example.com/alert',
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto('alert_destinations')
    .values({
      id,
      project_id: projectId,
      name: `dest-${randomBytes(3).toString('hex')}`,
      kind: 'slack',
      url_ciphertext: sealText(key, url),
      url_hint: 'https://hooks.example.com/…lert',
      secret_ciphertext: null,
      events,
    })
    .execute();
  return id;
}

const deliveries = (destinationId: string) =>
  db
    .selectFrom('alert_deliveries')
    .selectAll()
    .where('destination_id', '=', destinationId)
    .orderBy('created_at')
    .execute();

/** A request that cost `prompt` micro-dollars, against a budget of `limit`. */
function spend(projectId: string, prompt: number, limit: number): UsageEvent {
  const e = makeEvent({
    projectId,
    providerModel: model,
    startedAt: new Date(),
    usage: { promptTokens: prompt, completionTokens: 0, totalTokens: prompt },
  });
  return { ...e, budget: { limitMicroUsd: limit, reservedMicroUsd: prompt } };
}

const ingest = (events: UsageEvent[]) =>
  db.transaction().execute((trx) => ingestEvents(trx, events, undefined, { budgetAlerts: true }));

describe('budget alerts', () => {
  it('queues each threshold once a month, for that project only', async () => {
    const projectId = await createProject(db);
    const other = await createProject(db);
    const mine = await destination(projectId, ['budget']);
    const theirs = await destination(other, ['budget']);
    const breakerOnly = await destination(projectId, ['breaker']);

    const first = spend(projectId, 400, 1_000);
    await ingest([first]);
    expect(await deliveries(mine)).toHaveLength(0);
    // 400 -> 900 crosses 50% and 80% in one batch.
    const second = spend(projectId, 500, 1_000);
    await ingest([second]);
    // The same events again add no spend and queue nothing.
    await ingest([first, second]);
    // 900 -> 1,100 crosses 100%; 1,100 -> 1,300 crosses nothing.
    await ingest([spend(projectId, 200, 1_000)]);
    await ingest([spend(projectId, 200, 1_000)]);

    const rows = await deliveries(mine);
    const thresholds = rows.map((r) => (r.payload as { data: { thresholdPct: number } }).data);
    expect(thresholds.map((d) => d.thresholdPct).sort((a, b) => a - b)).toEqual([50, 80, 100]);
    expect(rows.every((r) => r.event_type === 'budget.threshold' && r.status === 'pending')).toBe(
      true,
    );
    expect(await deliveries(theirs)).toHaveLength(0);
    expect(await deliveries(breakerOnly)).toHaveLength(0);
  });
});

/**
 * The dispatcher tests' time: a year ago, so rows other test files queue (due at the real time)
 * are never due for these dispatchers, and these tests send only their own.
 */
const LAST_YEAR = Date.now() - 365 * 24 * 3_600_000;

describe('AlertDispatcher', () => {
  const settings: AlertSettings = {
    enabled: true,
    pollIntervalMs: 1_000,
    maxAttempts: 3,
    sendTimeoutMs: 1_000,
    retentionDays: 30,
  };
  const publicHost: Resolver = () => Promise.resolve([{ address: '93.184.215.14', family: 4 }]);

  function dispatcher(
    transport: Transport,
    resolve: Resolver = publicHost,
    clock = new ManualClock(LAST_YEAR),
  ) {
    return {
      clock,
      dispatcher: new AlertDispatcher(settings, {
        db,
        clock,
        logger: captureLogger().logger,
        random: () => 0.5,
        key,
        resolve,
        transport,
      }),
    };
  }

  async function queued(projectId: string, destinationId: string, at: number): Promise<string> {
    const id = uuidv7();
    await db
      .insertInto('alert_deliveries')
      .values({
        id,
        destination_id: destinationId,
        project_id: projectId,
        event_type: 'test',
        dedupe_key: `test:${id}`,
        payload: JSON.stringify({ type: 'test', timestamp: new Date(at).toISOString(), data: {} }),
        next_attempt_at: new Date(at),
      })
      .execute();
    return id;
  }

  const row = (id: string) =>
    db.selectFrom('alert_deliveries').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('retries a failed delivery after the first delay with jitter, then delivers it', async () => {
    const projectId = await createProject(db);
    const path = `/retry-${randomBytes(4).toString('hex')}`;
    const destinationId = await destination(
      projectId,
      ['budget'],
      `https://hooks.example.com${path}`,
    );
    const answers = [500, 204];
    const sent: { address: string; body: string }[] = [];
    const { clock, dispatcher: d } = dispatcher((target, body) => {
      // Other tests' queued deliveries share the table: answer them, count only this one's.
      if (target.url.pathname !== path) return Promise.resolve({ status: 204 });
      sent.push({ address: target.address, body });
      return Promise.resolve({ status: answers.shift()! });
    });
    const id = await queued(projectId, destinationId, clock.now());

    await d.runOnce();
    const failed = await row(id);
    expect(failed).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status: 500,
      last_error: 'the receiver answered 500',
    });
    // Half the 5 s delay plus half of the other half (random 0.5).
    expect(failed.next_attempt_at.getTime() - clock.now()).toBe(RETRY_DELAYS_MS[0]! * 0.75);
    await d.runOnce();
    expect(sent).toHaveLength(1);

    await clock.advance(RETRY_DELAYS_MS[0]!);
    await d.runOnce();
    expect(await row(id)).toMatchObject({ status: 'delivered', attempts: 2, last_status: 204 });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.address).toBe('93.184.215.14');
    expect(JSON.parse(sent[0]!.body)).toEqual({ text: 'AI Gateway: test alert for project "".' });
  });

  it('marks a delivery failed after the last attempt', async () => {
    const projectId = await createProject(db);
    const destinationId = await destination(projectId, ['budget']);
    const { clock, dispatcher: d } = dispatcher(() => Promise.reject(new Error('timed out')));
    const id = await queued(projectId, destinationId, clock.now());
    for (let i = 0; i < settings.maxAttempts; i++) {
      await d.runOnce();
      await clock.advance(RETRY_DELAYS_MS[i]!);
    }
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 3, last_error: 'timed out' });
  });

  it('never sends to a refused address, and fails such a delivery at once', async () => {
    const projectId = await createProject(db);
    const host = `refused-${randomBytes(4).toString('hex')}.example.com`;
    const destinationId = await destination(projectId, ['budget'], `https://${host}/x`);
    let calls = 0;
    const { clock, dispatcher: d } = dispatcher(
      (target) => {
        if (target.url.hostname === host || target.url.protocol !== 'https:') calls++;
        return Promise.resolve({ status: 204 });
      },
      (name) =>
        Promise.resolve([
          { address: name === host ? '169.254.169.254' : '93.184.215.14', family: 4 },
        ]),
    );
    const id = await queued(projectId, destinationId, clock.now());
    await d.runOnce();
    expect(calls).toBe(0);
    expect(await row(id)).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'refused a cloud metadata address',
    });
    // An http URL is refused the same way.
    const plain = await destination(projectId, ['budget'], 'http://hooks.example.com/alert');
    const second = await queued(projectId, plain, clock.now());
    await d.runOnce();
    expect(await row(second)).toMatchObject({ status: 'failed', last_error: 'not https' });
    expect(calls).toBe(0);
  });

  it('fails a delivery whose URL the key cannot open (the key changed)', async () => {
    const projectId = await createProject(db);
    const destinationId = await destination(projectId, ['budget']);
    const other = alertsKey({ ALERTS_ENCRYPTION_KEY: randomBytes(32).toString('base64') })!;
    const clock = new ManualClock(LAST_YEAR);
    const d = new AlertDispatcher(settings, {
      db,
      clock,
      logger: captureLogger().logger,
      random: () => 0.5,
      key: other,
      resolve: publicHost,
      transport: () => Promise.resolve({ status: 200 }),
    });
    const id = await queued(projectId, destinationId, clock.now());
    await d.runOnce();
    expect(await row(id)).toMatchObject({
      status: 'failed',
      last_error: 'cannot decrypt the URL (was the key changed?)',
    });
  });
});

describe('DeadLetterAlerts', () => {
  it('queues at most one alert per interval for every destination that chose it', async () => {
    const projectId = await createProject(db);
    const destinationId = await destination(projectId, ['dead_letters']);
    // A window of its own, far from the other tests' times.
    const clock = new ManualClock(Date.UTC(2031, 0, 1, 0, 0, 0) + Math.floor(Math.random() * 1e9));
    const alerts = new DeadLetterAlerts({
      db,
      clock,
      logger: captureLogger().logger,
      intervalMs: 3_600_000,
    });
    await alerts.deadLettered();
    await alerts.deadLettered();
    await clock.advance(60_000);
    await alerts.deadLettered();
    // A second worker in the same window queues nothing new (the dedupe key).
    await new DeadLetterAlerts({
      db,
      clock,
      logger: captureLogger().logger,
      intervalMs: 3_600_000,
    }).deadLettered();
    expect(await deliveries(destinationId)).toHaveLength(1);
    await clock.advance(3_600_000);
    await alerts.deadLettered();
    const rows = await deliveries(destinationId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.event_type === 'dead_letters.growing')).toBe(true);
  });
});
