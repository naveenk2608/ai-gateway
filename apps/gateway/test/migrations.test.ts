import { randomBytes } from 'node:crypto';
import { migrateDatabase } from '@ai-gateway/shared/node';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR } from '../src/gateway.js';
import { captureLogger } from './helpers.js';

const TABLES = [
  'api_keys',
  'audit_logs',
  'budget_periods',
  'budget_reservations',
  'failed_events',
  'model_deployments',
  'model_prices',
  'project_members',
  'projects',
  'provider_attempts',
  'provider_health_events',
  'request_records',
  'routing_policies',
  'usage_events',
  'user_sessions',
  'users',
];

const MIGRATIONS = ['0001_initial-schema', '0002_limits-and-budgets'];

/** A throwaway database, so migrations run from scratch. */
const dbName = `gw_migrate_${randomBytes(4).toString('hex')}`;
const adminUrl = process.env.DATABASE_URL!;
const freshUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
})();

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
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

describe('database migrations', () => {
  it('two instances starting together apply each migration exactly once', async () => {
    const run = () =>
      migrateDatabase({
        databaseUrl: freshUrl,
        dir: DEFAULT_MIGRATIONS_DIR,
        logger: captureLogger().logger,
      });
    const [first, second] = await Promise.all([run(), run()]);

    // One instance waited on the advisory lock, then found nothing pending.
    expect([...first, ...second]).toEqual(MIGRATIONS);

    await withClient(freshUrl, async (c) => {
      const tables = await c.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> 'pgmigrations' ORDER BY table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(TABLES);
      const applied = await c.query('SELECT name FROM pgmigrations');
      expect(applied.rowCount).toBe(MIGRATIONS.length);
    });

    // A later start is a no-op.
    expect(await run()).toEqual([]);
  });

  it('keeps price versions immutable', async () => {
    await withClient(freshUrl, async (c) => {
      await c.query(
        `INSERT INTO model_prices (id, provider, model, input_micro_usd_per_mtok,
           output_micro_usd_per_mtok, effective_from)
         VALUES (gen_random_uuid(), 'mock', 'mock', 100, 200, now())`,
      );
      await expect(c.query('UPDATE model_prices SET input_micro_usd_per_mtok = 1')).rejects.toThrow(
        /immutable/,
      );
    });
  });
});
