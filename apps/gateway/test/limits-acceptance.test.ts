/**
 * M4 acceptance: limits and budgets hold across two gateway instances sharing Redis and Postgres.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { uuidv7 } from '@ai-gateway/shared';
import { createRedis, closeRedis, type Db, type Redis } from '@ai-gateway/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, TEST_PEPPER, testConfig } from './helpers.js';

const tag = randomBytes(3).toString('hex');
/** Provider model names of their own, so their prices affect no other test. */
const exactModel = `exact-${tag}`;
const overModel = `over-${tag}`;

const models = parseModelsConfig(
  {
    deployments: {
      held: { provider: 'mock', mock: { latencyMs: 3_000, completionTokens: 1 } },
      exact: { provider: 'mock', model: exactModel, mock: { latencyMs: 50, completionTokens: 50 } },
      // Reports 200 prompt tokens where the gateway estimates 8: it costs more than reserved.
      over: {
        provider: 'mock',
        model: overModel,
        mock: { latencyMs: 100, completionTokens: 30, promptTokens: 200 },
      },
      quick: { provider: 'mock', mock: { completionTokens: 2 } },
    },
    models: {
      'mock-held': { deployment: 'held' },
      'mock-exact': { deployment: 'exact' },
      'mock-over': { deployment: 'over' },
      'mock-quick': { deployment: 'quick' },
    },
  },
  'limits-acceptance',
);

const DOLLAR = 1_000_000;
let a: Gateway;
let b: Gateway;
let urlA: string;
let urlB: string;
let db: Db;
let redis: Redis;

const urlOf = (g: Gateway) => `http://127.0.0.1:${(g.app.server.address() as AddressInfo).port}`;

beforeAll(async () => {
  // Both instances publish to one stream; A also runs the usage consumer, as on Render.
  const shared = {
    EVENTS_STREAM: `test:limits:${tag}`,
    EVENTS_DLQ_STREAM: `test:limits:${tag}:dlq`,
    EVENTS_CONSUMER_GROUP: `limits-${tag}`,
    WORKER_BLOCK_MS: '100',
  };
  a = createGateway(
    testConfig({ ...shared, RUN_WORKER_IN_PROCESS: 'true' }),
    captureLogger().logger,
    {
      models,
    },
  );
  b = createGateway(testConfig({ ...shared, MIGRATE_ON_START: 'false' }), captureLogger().logger, {
    models,
  });
  db = a.db;
  // $0.001 per completion token: 50 tokens cost $0.05. The over model also charges $0.0001 per
  // prompt token.
  const price = (model: string, input: number) => ({
    id: uuidv7(),
    provider: 'mock',
    model,
    input_micro_usd_per_mtok: input,
    output_micro_usd_per_mtok: 1_000 * DOLLAR,
    effective_from: new Date(0),
  });
  await a.start();
  await db
    .insertInto('model_prices')
    .values([price(exactModel, 0), price(overModel, 100 * DOLLAR)])
    .execute();
  await b.start();
  await a.prices.refresh();
  urlA = urlOf(a);
  urlB = urlOf(b);
  redis = createRedis(process.env.REDIS_URL!, captureLogger().logger, { offlineQueue: true });
});

afterAll(async () => {
  await Promise.all([a.shutdown(), b.shutdown(), closeRedis(redis)]);
});

interface Limits {
  rpm_limit?: number;
  concurrency_limit?: number;
  monthly_budget_micro_usd?: number;
  max_request_cost_micro_usd?: number;
}

async function limitedKey(limits: Limits): Promise<{ projectId: string; key: string }> {
  const projectId = await createProject(db);
  if (Object.keys(limits).length > 0) {
    await db.updateTable('projects').set(limits).where('id', '=', projectId).execute();
  }
  return { projectId, key: (await createApiKey(db, projectId)).plaintext };
}

async function chat(base: string, key: string, model: string, extra: object = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Say hello' }],
      ...extra,
    }),
  });
  const body = (await res.json()) as { error?: { code: string } };
  return { status: res.status, code: body.error?.code, retryAfter: res.headers.get('retry-after') };
}

/** Waits until the worker has stored `count` usage rows for the project, then sums their cost. */
async function recordedSpend(projectId: string, count: number): Promise<number> {
  let total = 0;
  await vi.waitFor(
    async () => {
      const row = await db
        .selectFrom('usage_events')
        .select((eb) => [
          eb.fn.countAll<string>().as('n'),
          eb.fn.sum<string>('cost_micro_usd').as('cost'),
        ])
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow();
      expect(Number(row.n)).toBe(count);
      total = Number(row.cost ?? 0);
    },
    { timeout: 10_000, interval: 100 },
  );
  return total;
}

async function ledgerSpend(projectId: string): Promise<number | undefined> {
  const row = await db
    .selectFrom('budget_periods')
    .select('spent_micro_usd')
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return row?.spent_micro_usd;
}

const countBy = <T>(items: T[], key: (item: T) => string) =>
  items.reduce<Record<string, number>>((acc, item) => {
    acc[key(item)] = (acc[key(item)] ?? 0) + 1;
    return acc;
  }, {});

describe('concurrency across two instances', () => {
  it('admits exactly 10 of 200 parallel requests against a limit of 10', async () => {
    const { key } = await limitedKey({ concurrency_limit: 10 });
    const mocks = [a, b].map((g) => g.registry.deployment('held')?.provider as MockProvider);
    const inFlight = () => mocks.reduce((sum, mock) => sum + mock.stats().active, 0);
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, inFlight())), 1);

    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => chat(i % 2 === 0 ? urlA : urlB, key, 'mock-held')),
    );
    clearInterval(sampler);

    expect(countBy(results, (r) => `${r.status} ${r.code ?? 'ok'}`)).toEqual({
      '200 ok': 10,
      '429 concurrency_limit_exceeded': 190,
    });
    expect(results.find((r) => r.status === 429)?.retryAfter).toBe('1');
    expect(peak).toBe(10);
    // Every slot is free again once the requests are done.
    await vi.waitFor(async () => expect((await chat(urlB, key, 'mock-quick')).status).toBe(200));
  });
});

describe('budgets across two instances', () => {
  it('stops at a $1.00 budget exactly when each request costs what it reserved ($0.05)', async () => {
    const { projectId, key } = await limitedKey({
      monthly_budget_micro_usd: DOLLAR,
      max_request_cost_micro_usd: DOLLAR / 20,
    });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        chat(i % 2 === 0 ? urlA : urlB, key, 'mock-exact', { max_tokens: 50 }),
      ),
    );
    expect(countBy(results, (r) => `${r.status} ${r.code ?? 'ok'}`)).toEqual({
      '200 ok': 20,
      '429 budget_exceeded': 80,
    });
    expect(await recordedSpend(projectId, 20)).toBe(DOLLAR);
    await vi.waitFor(async () => expect(await ledgerSpend(projectId)).toBe(DOLLAR));
  });

  it('keeps spend within budget + in-flight requests x max request cost when usage overshoots', async () => {
    const concurrency = 10;
    const maxRequestCost = DOLLAR / 20;
    const { projectId, key } = await limitedKey({
      concurrency_limit: concurrency,
      monthly_budget_micro_usd: DOLLAR,
      max_request_cost_micro_usd: maxRequestCost,
    });
    // Reserved: 8 x $0.0001 + 30 x $0.001 = $0.0308. Charged: 200 x $0.0001 + 30 x $0.001 = $0.05.
    let succeeded = 0;
    let budgetRejections = 0;
    const client = async (base: string) => {
      for (;;) {
        const res = await chat(base, key, 'mock-over', { max_tokens: 30 });
        if (res.status === 200) succeeded++;
        else if (res.code === 'budget_exceeded') return budgetRejections++;
        else if (res.code !== 'concurrency_limit_exceeded') throw new Error(`got ${res.status}`);
      }
    };
    await Promise.all(Array.from({ length: 20 }, (_, i) => client(i % 2 === 0 ? urlA : urlB)));

    expect(budgetRejections).toBe(20);
    const spent = await recordedSpend(projectId, succeeded);
    // ADR 009: overspend is bounded by the requests in flight times the most one can cost.
    expect(spent).toBeLessThanOrEqual(DOLLAR + concurrency * maxRequestCost);
    // Redis charged the same amounts the worker recorded.
    await vi.waitFor(async () => {
      const totals = await redis.hgetall(`gw:budget:${projectId}:${budgetPeriodKey()}`);
      expect({ spent: Number(totals.spent), reserved: Number(totals.reserved) }).toEqual({
        spent,
        reserved: 0,
      });
    });
  });

  it('rebuilds the budget from Postgres when Redis comes back empty', async () => {
    const { projectId, key } = await limitedKey({ monthly_budget_micro_usd: 4 * (DOLLAR / 20) });
    const exact = { max_tokens: 50 };
    for (const base of [urlA, urlB])
      expect((await chat(base, key, 'mock-exact', exact)).status).toBe(200);
    await recordedSpend(projectId, 2);
    await vi.waitFor(async () => expect(await ledgerSpend(projectId)).toBe(DOLLAR / 10));

    // Redis restarts with no data (Render's free Redis keeps none).
    await redis.del(`gw:budget:${projectId}:${budgetPeriodKey()}`);

    // $0.10 of $0.20 was spent before: two more fit, not four.
    expect((await chat(urlB, key, 'mock-exact', exact)).status).toBe(200);
    expect((await chat(urlA, key, 'mock-exact', exact)).status).toBe(200);
    expect(await chat(urlB, key, 'mock-exact', exact)).toMatchObject({
      status: 429,
      code: 'budget_exceeded',
    });
  });
});

function budgetPeriodKey(): string {
  return new Date().toISOString().slice(0, 7);
}

describe('a crashed request', () => {
  const fixture = fileURLToPath(new URL('./fixtures/limited-gateway.ts', import.meta.url));
  let child: ChildProcess | undefined;

  afterAll(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
  });

  it('frees its concurrency slot when its lease expires', async () => {
    const { projectId, key } = await limitedKey({ concurrency_limit: 1 });
    const proc = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fixture], {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        LOG_LEVEL: 'warn',
        API_KEY_PEPPER: TEST_PEPPER,
        MIGRATE_ON_START: 'false',
        // Renewed every second; it lapses 2-3 s after the last renewal.
        LIMITS_LEASE_TTL_MS: '3000',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child = proc;
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('message', (m: { port: number }) => resolve(m.port));
      proc.once('exit', (code) => reject(new Error(`fixture exited with ${code}`)));
    });

    // The request holds the only slot, then its gateway dies without releasing it.
    void chat(`http://127.0.0.1:${port}`, key, 'mock-held').catch(() => undefined);
    const leases = `gw:rl:conc:project:${projectId}`;
    await vi.waitFor(async () => expect(await redis.zcard(leases)).toBe(1), { timeout: 10_000 });
    proc.kill('SIGKILL');
    await new Promise((resolve) => proc.once('exit', resolve));
    const killedAt = Date.now();

    expect((await chat(urlA, key, 'mock-quick')).code).toBe('concurrency_limit_exceeded');
    await vi.waitFor(async () => expect((await chat(urlA, key, 'mock-quick')).status).toBe(200), {
      timeout: 10_000,
      interval: 100,
    });
    // Freed by expiry (at least 2 s after the last renewal), not by a release.
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1_000);
  });
});

describe('Redis unavailable (ADR 010)', () => {
  /** Nothing listens on port 1: every Redis command fails at once. */
  const deadRedis = { REDIS_URL: 'redis://127.0.0.1:1', MIGRATE_ON_START: 'false' };

  async function withGateway(failMode: string, run: (url: string) => Promise<void>) {
    const g = createGateway(
      testConfig({ ...deadRedis, LIMITS_FAIL_MODE: failMode }),
      captureLogger().logger,
      { models },
    );
    await g.start();
    try {
      await run(urlOf(g));
    } finally {
      await g.shutdown();
    }
  }

  it('rejects limited requests with 503 in closed mode', async () => {
    const limited = await limitedKey({ rpm_limit: 100 });
    const unlimited = await limitedKey({});
    await withGateway('closed', async (url) => {
      expect(await chat(url, limited.key, 'mock-quick')).toMatchObject({
        status: 503,
        code: 'limits_unavailable',
        retryAfter: '1',
      });
      // Nothing to enforce, nothing to fail on.
      expect((await chat(url, unlimited.key, 'mock-quick')).status).toBe(200);
    });
  });

  it('admits them unchecked in open mode', async () => {
    const limited = await limitedKey({ rpm_limit: 1, monthly_budget_micro_usd: 0 });
    await withGateway('open', async (url) => {
      for (let i = 0; i < 3; i++)
        expect((await chat(url, limited.key, 'mock-quick')).status).toBe(200);
    });
  });
});
