import { randomBytes } from 'node:crypto';
import { uuidv7, type UsageEvent } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/ingest.js';
import { connect, createProject, makeEvent } from './fixtures.js';

let pool: pg.Pool;
let db: Db;
/** An embeddings model of its own, priced on input only as embedding models are (M13). */
const embedModel = `embed-${randomBytes(3).toString('hex')}`;

beforeAll(async () => {
  ({ pool, db } = connect());
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: embedModel,
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 0,
      effective_from: new Date(0),
    })
    .execute();
});

afterAll(async () => {
  await pool.end();
});

const ingest = (events: UsageEvent[]) =>
  db.transaction().execute((trx) => ingestEvents(trx, events));

const endpointOf = async (requestId: string) =>
  (
    await db
      .selectFrom('request_records')
      .select('endpoint')
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow()
  ).endpoint;

describe('the endpoint of each request record (M13)', () => {
  it('stores the endpoint an event names, and chat for events from older gateways', async () => {
    const project = await createProject(db);
    const base = makeEvent({
      projectId: project,
      providerModel: embedModel,
      usage: { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000 },
    });
    const embeddings: UsageEvent = {
      ...base,
      request: { ...base.request, endpoint: 'embeddings' },
    };
    // Events from gateways before M13 carry no endpoint at all.
    const older = makeEvent({ projectId: project });
    expect(older.request).not.toHaveProperty('endpoint');
    await ingest([embeddings, older]);
    expect(await endpointOf(embeddings.request.id)).toBe('embeddings');
    expect(await endpointOf(older.request.id)).toBe('chat');

    // Input-only price: 1,000 tokens at $1 per million.
    const usage = await db
      .selectFrom('usage_events')
      .select(['cost_micro_usd', 'completion_tokens'])
      .where('request_id', '=', embeddings.request.id)
      .executeTakeFirstOrThrow();
    expect(usage).toEqual({ cost_micro_usd: 1_000, completion_tokens: 0 });
  });
});
