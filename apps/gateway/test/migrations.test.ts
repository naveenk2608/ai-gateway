import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  // A view: the per-request values the analytics rollups sum.
  'request_rollup_facts',
  'routing_policies',
  'usage_events',
  'usage_rollups_day',
  'usage_rollups_hour',
  'usage_rollups_minute',
  'user_sessions',
  'users',
];

const MIGRATIONS = [
  '0001_initial-schema',
  '0002_limits-and-budgets',
  '0003_response-cache',
  '0004_usage-rollups',
  '0005_provider-names',
  '0006_provider-prices',
  '0007_billed-cost',
];

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

/** A database migrated to M10 (0001–0004), holding a Groq request costed before M11. */
describe('M11 provider names and billed cost on existing data', () => {
  const m11Db = `gw_migrate_m11_${randomBytes(4).toString('hex')}`;
  const m11Url = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${m11Db}`;
    return url.toString();
  })();
  const ids = {
    project: '0192f000-0000-7000-8000-00000000a001',
    request: '0192f000-0000-7000-8000-00000000a002',
    attempt: '0192f000-0000-7000-8000-00000000a003',
    usage: '0192f000-0000-7000-8000-00000000a004',
    event: '0192f000-0000-7000-8000-00000000a005',
    price: '0192f000-0000-7000-8000-00000000a006',
  };

  beforeAll(async () => {
    await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${m11Db}`));
  });

  afterAll(async () => {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${m11Db} WITH (FORCE)`));
  });

  it('relabels Groq rows and adds billed cost without changing any id, price or cost', async () => {
    const before = await mkdtemp(join(tmpdir(), 'gw-migrations-'));
    for (const file of await readdir(DEFAULT_MIGRATIONS_DIR)) {
      if (/^000[1-4]_/.test(file))
        await copyFile(join(DEFAULT_MIGRATIONS_DIR, file), join(before, file));
    }
    const logger = captureLogger().logger;
    await migrateDatabase({ databaseUrl: m11Url, dir: before, logger });
    await withClient(m11Url, async (c) => {
      await c.query(`INSERT INTO projects (id, name) VALUES ($1, 'm11')`, [ids.project]);
      await c.query(
        `INSERT INTO model_prices (id, provider, model, input_micro_usd_per_mtok,
           output_micro_usd_per_mtok, effective_from)
         VALUES ($1, 'openai-compatible', 'openai/gpt-oss-20b', 75000, 300000, '2026-10-21T00:00:00Z')`,
        [ids.price],
      );
      await c.query(
        `INSERT INTO request_records (id, project_id, model, deployment, stream, status, http_status,
           attempt_count, started_at, completed_at, latency_ms)
         VALUES ($1, $2, 'chat-default', 'groq-gpt-oss-20b', false, 'success', 200, 1,
           '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', 1000)`,
        [ids.request, ids.project],
      );
      await c.query(
        `INSERT INTO provider_attempts (id, request_id, attempt_number, deployment, provider,
           provider_model, outcome, started_at, completed_at, latency_ms)
         VALUES ($1, $2, 1, 'groq-gpt-oss-20b', 'openai-compatible', 'openai/gpt-oss-20b',
           'success', '2026-11-01T10:00:00Z', '2026-11-01T10:00:01Z', 1000)`,
        [ids.attempt, ids.request],
      );
      await c.query(
        `INSERT INTO usage_events (id, event_id, request_id, project_id, deployment, provider,
           provider_model, prompt_tokens, completion_tokens, total_tokens, usage_source,
           cost_micro_usd, price_id, occurred_at)
         VALUES ($1, $2, $3, $4, 'groq-gpt-oss-20b', 'openai-compatible', 'openai/gpt-oss-20b',
           1000, 2000, 3000, 'reported', 675, $5, '2026-11-01T10:00:01Z')`,
        [ids.usage, ids.event, ids.request, ids.project, ids.price],
      );
      await c.query('SELECT rollup_requests(ARRAY[$1]::uuid[])', [ids.request]);
    });

    expect(
      await migrateDatabase({ databaseUrl: m11Url, dir: DEFAULT_MIGRATIONS_DIR, logger }),
    ).toEqual(MIGRATIONS.slice(4));

    await withClient(m11Url, async (c) => {
      const price = await c.query(
        `SELECT provider, input_micro_usd_per_mtok, output_micro_usd_per_mtok FROM model_prices
          WHERE id = $1`,
        [ids.price],
      );
      expect(price.rows).toEqual([
        {
          provider: 'groq',
          input_micro_usd_per_mtok: '75000',
          output_micro_usd_per_mtok: '300000',
        },
      ]);
      // The relabelled row is the only Groq gpt-oss-20b price: migration 0006 added no duplicate.
      const groq = await c.query(
        `SELECT count(*)::int AS n FROM model_prices WHERE provider = 'groq' AND model = 'openai/gpt-oss-20b'`,
      );
      expect(groq.rows[0]).toEqual({ n: 1 });
      const usage = await c.query(
        `SELECT provider, cost_micro_usd, billed_cost_micro_usd, price_id, billing FROM usage_events
          WHERE id = $1`,
        [ids.usage],
      );
      expect(usage.rows).toEqual([
        {
          provider: 'groq',
          cost_micro_usd: '675',
          billed_cost_micro_usd: '675',
          price_id: ids.price,
          billing: null,
        },
      ]);
      const attempt = await c.query('SELECT provider FROM provider_attempts WHERE id = $1', [
        ids.attempt,
      ]);
      expect(attempt.rows).toEqual([{ provider: 'groq' }]);
      for (const table of ['usage_rollups_minute', 'usage_rollups_hour', 'usage_rollups_day']) {
        const rollup = await c.query(
          `SELECT provider, cost_micro_usd, billed_cost_micro_usd, unpriced_requests FROM ${table}
            WHERE project_id = $1`,
          [ids.project],
        );
        expect(rollup.rows, table).toEqual([
          {
            provider: 'groq',
            cost_micro_usd: '675',
            billed_cost_micro_usd: '675',
            unpriced_requests: '0',
          },
        ]);
      }
      // The price stays immutable once relabelled.
      await expect(
        c.query(`UPDATE model_prices SET provider = 'x' WHERE id = $1`, [ids.price]),
      ).rejects.toThrow(/immutable/);
    });
  });
});
