import { randomBytes } from 'node:crypto';
import { ManualClock, uuidv7 } from '@ai-gateway/shared';
import { createDb, createPgPool, migrateDatabase, type Db } from '@ai-gateway/shared/node';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneGuardrailResults } from '../src/retention.js';
import { createUsageConsumer, DEFAULT_MIGRATIONS_DIR } from '../src/worker.js';
import { captureLogger, createProject, isolatedSettings } from './fixtures.js';

// Guardrail findings (migration 0016, ADR 035) are kept as long as the raw rows they describe
// (RAW_RETENTION_MONTHS, ADR 039; M19). A throwaway database: retention deletes across every
// project, so it cannot share one with other test files.
const dbName = `gw_guard_retention_${randomBytes(4).toString('hex')}`;
const adminUrl = process.env.DATABASE_URL!;
const url = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
let pool: pg.Pool;
let db: Db;
let project: string;

async function admin(query: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await admin(`CREATE DATABASE ${dbName}`);
  const { logger } = captureLogger();
  await migrateDatabase({ databaseUrl: url, dir: DEFAULT_MIGRATIONS_DIR, logger });
  pool = createPgPool(url, logger);
  db = createDb(pool);
  project = await createProject(db);
});

afterAll(async () => {
  await pool?.end();
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

beforeEach(async () => {
  await db.deleteFrom('guardrail_results').execute();
});

/** One finding per time, as the worker stores them: keyed by the request's start. */
async function findingsAt(times: string[]): Promise<void> {
  await db
    .insertInto('guardrail_results')
    .values(
      times.map((at) => ({
        id: uuidv7(Date.parse(at)),
        request_id: uuidv7(Date.parse(at)),
        project_id: project,
        stage: 'input' as const,
        check: 'email',
        findings: 1,
        action: 'mask' as const,
        created_at: at,
      })),
    )
    .execute();
}

const left = async () =>
  (
    await db.selectFrom('guardrail_results').select('created_at').orderBy('created_at').execute()
  ).map((r) => new Date(r.created_at).toISOString());

// 2026-06-15 with 6 months kept: the cutoff is 2025-12-01, where the raw partitions' is.
const NOW = Date.parse('2026-06-15T12:00:00Z');
const ON = { enabled: true, aheadMonths: 3, retentionMonths: 6 };
const OLD = [
  '2025-06-01T00:00:00.000Z',
  '2025-09-10T08:00:00.000Z',
  '2025-11-02T00:00:00.000Z',
  '2025-11-20T10:00:00.000Z',
  '2025-11-30T23:59:59.999Z',
];
const KEPT = ['2025-12-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-06-15T11:00:00.000Z'];

describe('guardrail_results retention', () => {
  it('deletes findings older than the raw partitions cutoff and keeps the rest', async () => {
    await findingsAt([...OLD, ...KEPT]);
    expect(await pruneGuardrailResults(db, NOW, ON)).toBe(OLD.length);
    expect(await left()).toEqual(KEPT);
  });

  it('deletes in batches until none is left past the cutoff', async () => {
    await findingsAt([...OLD, ...KEPT]);
    // 5 old rows in batches of 2: three statements (2, 2, 1).
    expect(await pruneGuardrailResults(db, NOW, ON, 2)).toBe(OLD.length);
    expect(await left()).toEqual(KEPT);
    expect(await pruneGuardrailResults(db, NOW, ON, 2)).toBe(0);
  });

  it('deletes nothing when partitions are off or RAW_RETENTION_MONTHS is 0', async () => {
    await findingsAt([...OLD, ...KEPT]);
    expect(await pruneGuardrailResults(db, NOW, { ...ON, enabled: false })).toBe(0);
    expect(await pruneGuardrailResults(db, NOW, { ...ON, retentionMonths: 0 })).toBe(0);
    expect(await left()).toEqual([...OLD, ...KEPT]);
  });

  it("runs on the usage consumer's retention schedule", async () => {
    await findingsAt([...OLD, ...KEPT]);
    const clock = new ManualClock(NOW);
    const created = createUsageConsumer({
      settings: isolatedSettings({ RAW_PARTITIONS_ENABLED: true, RAW_RETENTION_MONTHS: 6 }),
      redisUrl: process.env.REDIS_URL!,
      db,
      logger: captureLogger().logger,
      clock,
    });
    await created.consumer.start();
    try {
      // The first retention pass runs as the consumer starts.
      await vi.waitFor(async () => expect(await left()).toEqual(KEPT), {
        timeout: 10_000,
        interval: 100,
      });
    } finally {
      await created.consumer.stop();
      await created.close();
    }
  });
});
