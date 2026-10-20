import { randomBytes } from 'node:crypto';
import { uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/ingest.js';
import { connect, createProject, makeEvent } from './fixtures.js';

let pool: pg.Pool;
let db: Db;
/** A provider model of its own, so its price affects no other test. */
const model = `ledger-${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  ({ pool, db } = connect());
  // 1 micro-dollar per prompt token, 2 per completion token.
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model,
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 2_000_000,
      effective_from: new Date(0),
    })
    .execute();
});

afterAll(async () => {
  await pool.end();
});

const usage = (prompt: number, completion: number) => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
});

function event(projectId: string, startedAt: Date, cost: [number, number], budget?: number) {
  const e = makeEvent({ projectId, providerModel: model, startedAt, usage: usage(...cost) });
  return budget === undefined
    ? e
    : { ...e, budget: { limitMicroUsd: budget, reservedMicroUsd: 500 } };
}

const ingest = (events: UsageEvent[]) =>
  db.transaction().execute((trx) => ingestEvents(trx, events));

async function period(projectId: string, start: Date) {
  return db
    .selectFrom('budget_periods')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('period_start', '=', start)
    .executeTakeFirst();
}

const october = new Date(Date.UTC(2026, 9, 1));

describe('monthly spend ledger (budget_periods)', () => {
  it("adds each request's cost to the month it started in, exactly once", async () => {
    const projectId = await createProject(db);
    const a = event(projectId, new Date(Date.UTC(2026, 9, 5)), [100, 50]); // 200
    const b = event(projectId, new Date(Date.UTC(2026, 9, 31, 23, 59)), [10, 5]); // 20
    const november = event(projectId, new Date(Date.UTC(2026, 10, 1)), [1, 0]); // 1
    // The same event twice in one batch, then again in a later batch.
    await ingest([a, a, b, november]);
    await ingest([a, b]);

    expect(await period(projectId, october)).toMatchObject({
      spent_micro_usd: 220,
      limit_micro_usd: null,
      period_end: new Date(Date.UTC(2026, 10, 1)),
    });
    expect((await period(projectId, new Date(Date.UTC(2026, 10, 1))))?.spent_micro_usd).toBe(1);
  });

  it('keeps the last budget the gateway reported, and adds nothing for unpriced usage', async () => {
    const projectId = await createProject(db);
    await ingest([event(projectId, new Date(Date.UTC(2026, 9, 2)), [0, 0], 5_000)]);
    expect(await period(projectId, october)).toMatchObject({
      spent_micro_usd: 0,
      limit_micro_usd: 5_000,
    });
    await ingest([event(projectId, new Date(Date.UTC(2026, 9, 3)), [1, 1])]);
    expect(await period(projectId, october)).toMatchObject({
      spent_micro_usd: 3,
      limit_micro_usd: 5_000,
    });
  });
});

describe('budget reservation audit (budget_reservations)', () => {
  it('records each reservation with the actual cost, once', async () => {
    const projectId = await createProject(db);
    const e = event(projectId, new Date(Date.UTC(2026, 9, 6)), [100, 100], 10_000);
    await ingest([e]);
    await ingest([e]);
    const rows = await db
      .selectFrom('budget_reservations')
      .selectAll()
      .where('project_id', '=', projectId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      request_id: e.request.id,
      reserved_micro_usd: 500,
      actual_micro_usd: 300,
      status: 'reconciled',
      created_at: new Date(e.request.startedAt),
      settled_at: new Date(e.request.completedAt),
    });
  });

  it('reconciles a reservation the sweeper had already expired', async () => {
    const projectId = await createProject(db);
    const e = event(projectId, new Date(Date.UTC(2026, 9, 7)), [10, 10], 10_000);
    const periodId = uuidv7();
    await db
      .insertInto('budget_periods')
      .values({
        id: periodId,
        project_id: projectId,
        period_start: october,
        period_end: new Date(Date.UTC(2026, 10, 1)),
        limit_micro_usd: null,
      })
      .execute();
    await db
      .insertInto('budget_reservations')
      .values({
        id: uuidv7(),
        budget_period_id: periodId,
        project_id: projectId,
        request_id: e.request.id,
        reserved_micro_usd: 500,
        status: 'expired',
        settled_at: new Date(),
      })
      .execute();

    await ingest([e]);
    const row = await db
      .selectFrom('budget_reservations')
      .selectAll()
      .where('request_id', '=', e.request.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'reconciled', actual_micro_usd: 30 });
    expect((await period(projectId, october))?.spent_micro_usd).toBe(30);
  });
});
