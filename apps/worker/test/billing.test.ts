import { randomBytes } from 'node:crypto';
import { uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/ingest.js';
import { connect, createProject, makeEvent } from './fixtures.js';

let pool: pg.Pool;
let db: Db;
/** Provider models of their own, so their prices affect no other test. */
const priced = `billing-${randomBytes(3).toString('hex')}`;
const unpriced = `billing-free-${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  ({ pool, db } = connect());
  // 1 micro-dollar per prompt token, 2 per completion token.
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: priced,
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 2_000_000,
      effective_from: new Date(0),
    })
    .execute();
});

afterAll(async () => {
  await pool.end();
});

const ingest = (events: UsageEvent[]) =>
  db.transaction().execute((trx) => ingestEvents(trx, events));

/** An event served by `model`, with the attempt's billing set (or left out, as before M11). */
function event(
  projectId: string,
  model: string,
  billing: 'free_tier' | 'paid' | undefined,
  startedAt = new Date(),
) {
  const e = makeEvent({
    projectId,
    providerModel: model,
    startedAt,
    usage: { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 },
  });
  return {
    ...e,
    attempts: e.attempts.map((a) => (billing === undefined ? a : { ...a, billing })),
  };
}

async function usageRow(requestId: string) {
  return db
    .selectFrom('usage_events')
    .select(['cost_micro_usd', 'billed_cost_micro_usd', 'billing'])
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
}

describe('list cost and billed cost (ADR 024)', () => {
  it('bills a free-tier request nothing while keeping its list cost', async () => {
    const project = await createProject(db);
    const e = event(project, priced, 'free_tier');
    await ingest([e]);
    // 1,000 x $1/M + 500 x $2/M = 2,000 micro-dollars at list price.
    expect(await usageRow(e.request.id)).toEqual({
      cost_micro_usd: 2_000,
      billed_cost_micro_usd: 0,
      billing: 'free_tier',
    });
  });

  it('bills a paid request its list cost, and treats an event without billing as paid', async () => {
    const project = await createProject(db);
    const paid = event(project, priced, 'paid');
    const older = event(project, priced, undefined);
    await ingest([paid, older]);
    expect(await usageRow(paid.request.id)).toEqual({
      cost_micro_usd: 2_000,
      billed_cost_micro_usd: 2_000,
      billing: 'paid',
    });
    expect(await usageRow(older.request.id)).toMatchObject({
      billed_cost_micro_usd: 2_000,
      billing: 'paid',
    });
  });

  it('leaves the list cost of an unpriced model unknown, never zero', async () => {
    const project = await createProject(db);
    const e = event(project, unpriced, 'free_tier');
    await ingest([e]);
    expect(await usageRow(e.request.id)).toEqual({
      cost_micro_usd: null,
      billed_cost_micro_usd: 0,
      billing: 'free_tier',
    });
  });

  it('sums list cost, billed cost and unpriced requests in the rollups', async () => {
    const project = await createProject(db);
    const at = new Date(Date.UTC(2026, 10, 3, 12, 0, 0));
    await ingest([
      event(project, priced, 'free_tier', at),
      event(project, priced, 'paid', new Date(at.getTime() + 1_000)),
      event(project, unpriced, 'free_tier', new Date(at.getTime() + 2_000)),
    ]);
    for (const table of ['usage_rollups_minute', 'usage_rollups_hour', 'usage_rollups_day']) {
      const { rows } = await sql<{ list: string; billed: string; unpriced: string; n: string }>`
        SELECT sum(cost_micro_usd) AS list, sum(billed_cost_micro_usd) AS billed,
          sum(unpriced_requests) AS unpriced, sum(requests) AS n
        FROM ${sql.table(table)} WHERE project_id = ${project}`.execute(db);
      const sums = rows[0]!;
      expect([sums.list, sums.billed, sums.unpriced, sums.n].map(Number), table).toEqual([
        4_000, 2_000, 1, 3,
      ]);
    }
  });

  it('never changes a stored billed cost when the same event arrives again', async () => {
    const project = await createProject(db);
    const e = event(project, priced, 'free_tier');
    await ingest([e]);
    // Re-delivered with a different billing (as if the deployment changed): nothing moves.
    await ingest([{ ...e, attempts: e.attempts.map((a) => ({ ...a, billing: 'paid' as const })) }]);
    expect(await usageRow(e.request.id)).toMatchObject({
      billed_cost_micro_usd: 0,
      billing: 'free_tier',
    });
  });
});
