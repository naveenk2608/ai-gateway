import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, createPgPool, migrateDatabase } from '@ai-gateway/shared/node';
import { maintainPartitions, monthStart } from '@ai-gateway/worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from '../src/gateway.js';
import { captureLogger } from './helpers.js';

// Migration 0017 (M17, ADR 039) on a copy of the schema with sample rows: the raw tables become
// monthly partitions keeping every row, re-delivered events are still dropped, the worker creates
// and drops partitions, and the down migration restores plain tables.
const dbName = `gw_partitions_${randomBytes(4).toString('hex')}`;
const adminUrl = process.env.DATABASE_URL!;
const url = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
const MIGRATION = '0017_partition-raw-tables';

async function withClient<T>(target: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${dbName}`));
});

afterAll(async () => {
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));
});

const project = '0192f000-0000-7000-8000-00000000b001';
const DAY = 86_400_000;
/** Three requests: two months ago, last month and now, each with an attempt and a usage row. */
function samples(now: number) {
  return [
    monthStart(now, -2).getTime() + 3 * DAY,
    monthStart(now, -1).getTime() + 10 * DAY,
    now - 60_000,
  ].map((at, i) => ({
    request: `0192f000-0000-7000-8000-0000000c000${i}`,
    attempt: `0192f000-0000-7000-8000-0000000d000${i}`,
    usage: `0192f000-0000-7000-8000-0000000e000${i}`,
    event: `0192f000-0000-7000-8000-0000000f000${i}`,
    at: new Date(at),
    done: new Date(at + 1_000),
  }));
}

async function insertSample(c: pg.Client, s: ReturnType<typeof samples>[number]) {
  await c.query(
    `INSERT INTO request_records (id, project_id, model, deployment, stream, status, http_status,
       attempt_count, started_at, completed_at, latency_ms)
     VALUES ($1, $2, 'mock-1', 'mock', false, 'success', 200, 1, $3, $4, 1000)
     ON CONFLICT DO NOTHING`,
    [s.request, project, s.at, s.done],
  );
  await c.query(
    `INSERT INTO provider_attempts (id, request_id, attempt_number, deployment, provider,
       provider_model, outcome, started_at, completed_at, latency_ms)
     VALUES ($1, $2, 1, 'mock', 'mock', 'mock', 'success', $3, $4, 1000)
     ON CONFLICT DO NOTHING`,
    [s.attempt, s.request, s.at, s.done],
  );
  return c.query(
    `INSERT INTO usage_events (id, event_id, request_id, project_id, deployment, provider,
       provider_model, prompt_tokens, completion_tokens, total_tokens, usage_source,
       cost_micro_usd, occurred_at)
     VALUES ($1, $2, $3, $4, 'mock', 'mock', 'mock', 10, 20, 30, 'reported', 0, $5)
     ON CONFLICT DO NOTHING`,
    [s.usage, s.event, s.request, project, s.done],
  );
}

const counts = (c: pg.Client) =>
  c
    .query<{ r: string; a: string; u: string }>(
      `SELECT (SELECT count(*) FROM request_records) AS r,
              (SELECT count(*) FROM provider_attempts) AS a,
              (SELECT count(*) FROM usage_events) AS u`,
    )
    .then((res) => [Number(res.rows[0]!.r), Number(res.rows[0]!.a), Number(res.rows[0]!.u)]);

const partitioned = (c: pg.Client) =>
  c
    .query<{ relname: string }>(
      `SELECT c.relname FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
        ORDER BY c.relname`,
    )
    .then((res) => res.rows.map((r) => r.relname));

const partitionOf = (c: pg.Client, id: string) =>
  c
    .query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM request_records WHERE id = $1`,
      [id],
    )
    .then((res) => res.rows[0]?.part);

const ym = (d: Date) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

describe('monthly partitions for the raw tables (migration 0017)', () => {
  it('converts the tables keeping every row, keeps dropping re-delivered events, and goes back', async () => {
    const logger = captureLogger().logger;
    const now = Date.now();
    const rows = samples(now);

    // The schema as it was before 0017, with rows in three months.
    // Later migrations are left out of both copies: this cycles 0017 alone up, down and up.
    const before = await mkdtemp(join(tmpdir(), 'gw-partitions-'));
    const through = await mkdtemp(join(tmpdir(), 'gw-partitions-0017-'));
    for (const file of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (file.slice(0, 4) < '0017') {
        await copyFile(join(DEFAULT_MIGRATIONS_DIR, file), join(before, file));
      }
      if (file.slice(0, 4) <= '0017') {
        await copyFile(join(DEFAULT_MIGRATIONS_DIR, file), join(through, file));
      }
    }
    await migrateDatabase({ databaseUrl: url, dir: before, logger });
    await withClient(url, async (c) => {
      await c.query(`INSERT INTO projects (id, name) VALUES ($1, 'partitions')`, [project]);
      for (const s of rows) await insertSample(c, s);
      await c.query('SELECT rollup_requests($1::uuid[])', [rows.map((s) => s.request)]);
      expect(await counts(c)).toEqual([3, 3, 3]);
    });

    // Up.
    expect(await migrateDatabase({ databaseUrl: url, dir: through, logger })).toContain(MIGRATION);
    await withClient(url, async (c) => {
      expect(await partitioned(c)).toEqual([
        'provider_attempts',
        'request_records',
        'usage_events',
      ]);
      expect(await counts(c)).toEqual([3, 3, 3]);
      // Each row sits in its month's partition; the partitions run three months ahead.
      expect(await partitionOf(c, rows[0]!.request)).toBe(`request_records_${ym(rows[0]!.at)}`);
      expect(await partitionOf(c, rows[2]!.request)).toBe(`request_records_${ym(rows[2]!.at)}`);
      const ahead = await c.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [
        `request_records_${ym(monthStart(now, 3))}`,
      ]);
      expect(ahead.rows[0]!.t).not.toBeNull();
      // The rollup view reads the new tables.
      const facts = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM request_rollup_facts`,
      );
      expect(facts.rows[0]!.n).toBe(3);
      // A re-delivered event is dropped, as before (ADR 014).
      const again = await insertSample(c, rows[1]!);
      expect(again.rowCount).toBe(0);
      expect(await counts(c)).toEqual([3, 3, 3]);
      // A row outside every monthly partition lands in the default one instead of failing.
      const old = {
        ...rows[0]!,
        request: '0192f000-0000-7000-8000-0000000c0009',
        attempt: '0192f000-0000-7000-8000-0000000d0009',
        usage: '0192f000-0000-7000-8000-0000000e0009',
        event: '0192f000-0000-7000-8000-0000000f0009',
        at: new Date(Date.UTC(2020, 0, 15)),
        done: new Date(Date.UTC(2020, 0, 15, 0, 0, 1)),
      };
      await insertSample(c, old);
      expect(await partitionOf(c, old.request)).toBe('request_records_default');
      // Creating that month's partition moves the row into it.
      await c.query(`SELECT gw_create_month_partition('request_records', 'started_at', $1)`, [
        old.at,
      ]);
      expect(await partitionOf(c, old.request)).toBe('request_records_2020_01');
    });

    // The worker's maintenance: months ahead exist, and with one month kept the older ones go.
    const pool = createPgPool(url, logger);
    try {
      const db = createDb(pool);
      const first = await maintainPartitions(db, now, {
        enabled: true,
        aheadMonths: 4,
        retentionMonths: 0,
      });
      expect(first.created).toBe(3); // the fourth month ahead, for each of the three tables
      const pruned = await maintainPartitions(db, now, {
        enabled: true,
        aheadMonths: 4,
        retentionMonths: 1,
      });
      // Two months ago (all three tables) and January 2020 (request_records) are dropped;
      // the 2020 attempt and usage rows were in the default partitions and are deleted there.
      expect(pruned).toMatchObject({ created: 0, dropped: 4, defaultDeleted: 2 });
      await withClient(url, async (c) => {
        expect(await counts(c)).toEqual([2, 2, 2]);
        const gone = await c.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [
          `request_records_${ym(rows[0]!.at)}`,
        ]);
        expect(gone.rows[0]!.t).toBeNull();
      });
      // Switched off, it touches nothing.
      expect(
        await maintainPartitions(db, now, { enabled: false, aheadMonths: 9, retentionMonths: 1 }),
      ).toEqual({
        created: 0,
        dropped: 0,
        defaultDeleted: 0,
      });
    } finally {
      await pool.end();
    }

    // Down: plain tables again with their original keys, every remaining row kept.
    const down = (await readFile(join(DEFAULT_MIGRATIONS_DIR, `${MIGRATION}.sql`), 'utf8')).split(
      '-- Down Migration',
    )[1]!;
    await withClient(url, async (c) => {
      await c.query('BEGIN');
      await c.query(down);
      await c.query(`DELETE FROM pgmigrations WHERE name = $1`, [MIGRATION]);
      await c.query('COMMIT');
      expect(await partitioned(c)).toEqual([]);
      expect(await counts(c)).toEqual([2, 2, 2]);
      const keys = await c.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conname IN ('request_records_pkey', 'usage_events_event_id_key',
                            'usage_events_request_id_fkey', 'provider_attempts_request_id_fkey')
          ORDER BY conname`,
      );
      expect(keys.rows.map((r) => r.conname)).toEqual([
        'provider_attempts_request_id_fkey',
        'request_records_pkey',
        'usage_events_event_id_key',
        'usage_events_request_id_fkey',
      ]);
      const facts = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM request_rollup_facts`,
      );
      expect(facts.rows[0]!.n).toBe(2);
    });
    // And up again, as a later deploy would.
    expect(await migrateDatabase({ databaseUrl: url, dir: through, logger })).toEqual([MIGRATION]);
    await withClient(url, async (c) => {
      expect(await counts(c)).toEqual([2, 2, 2]);
    });
  });
});
