import type { Db } from '@ai-gateway/shared/node';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/ingest.js';
import { connect, createProject, makeEvent } from './fixtures.js';

// Guardrail findings (M16, ADR 035) carried by usage events and stored once per request.
let pool: pg.Pool;
let db: Db;

beforeAll(() => {
  ({ pool, db } = connect());
});

afterAll(async () => {
  await pool.end();
});

describe('guardrail records', () => {
  it('stores each finding with its request, once, and never a value', async () => {
    const projectId = await createProject(db);
    const event = {
      ...makeEvent({ projectId }),
      guardrails: [
        { stage: 'input' as const, check: 'email', count: 2, action: 'mask' as const },
        { stage: 'output' as const, check: 'schema', count: 1, action: 'retry' as const },
      ],
    };
    const ingest = () => db.transaction().execute((trx) => ingestEvents(trx, [event]));
    await ingest();
    // The same event delivered again adds nothing.
    await ingest();
    const rows = await db
      .selectFrom('guardrail_results')
      .select(['stage', 'check', 'findings', 'action', 'project_id'])
      .where('request_id', '=', event.request.id)
      .orderBy('stage')
      .execute();
    expect(rows).toEqual([
      { stage: 'input', check: 'email', findings: 2, action: 'mask', project_id: projectId },
      { stage: 'output', check: 'schema', findings: 1, action: 'retry', project_id: projectId },
    ]);
  });
});
