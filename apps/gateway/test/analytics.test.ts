/**
 * M6: the analytics API against real traffic through the gateway, its range rules, project
 * isolation, the spend projection, and a scan of every admin response for secrets, prompts and
 * stack traces.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ANALYTICS_RANGES, budgetPeriodAt, uuidv7, type UsageEvent } from '@ai-gateway/shared';
import { ingestEvents } from '@ai-gateway/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import {
  createApiKey,
  createProject,
  createUser,
  type TestKey,
  type TestUser,
} from './db-fixtures.js';
import { captureLogger, TEST_PEPPER, testConfig } from './helpers.js';

const tag = randomBytes(3).toString('hex');
/** A provider model with a price of its own, so costs are real and no other test sees them. */
const pricedModel = `analytics-${tag}`;
const ok = `ok-${tag}`;
const broken = `broken-${tag}`;

const models = parseModelsConfig(
  {
    deployments: {
      [ok]: { provider: 'mock', model: pricedModel, mock: { completionTokens: 5 } },
      [broken]: { provider: 'mock', model: pricedModel, mock: { failWith: 500 } },
    },
    models: {
      'm-ok': { deployment: ok },
      'm-broken': { deployment: broken },
      'm-failover': { policy: 'priority', targets: [{ deployment: broken }, { deployment: ok }] },
    },
  },
  'analytics-test',
);

let gateway: Gateway;
let url: string;
const routes: string[] = [];

interface Fixture {
  projectA: string;
  projectB: string;
  owner: TestUser;
  cookie: string;
  keyA: TestKey;
  limitedKey: TestKey;
  keyB: TestKey;
  prompt: string;
  requestIds: string[];
}
let f: Fixture;

async function login(user: TestUser): Promise<string> {
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

async function chat(key: string, model: string, content: string): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  await res.text();
  return res.headers.get('x-request-id')!;
}

async function get<T = Record<string, unknown>>(path: string, cookie = f.cookie) {
  const res = await fetch(`${url}${path}`, { headers: { cookie } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as T };
}

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:analytics:${tag}`,
      EVENTS_DLQ_STREAM: `test:analytics:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `analytics-${tag}`,
      WORKER_BLOCK_MS: '100',
      RETRY_BASE_DELAY_MS: '1',
      RETRY_MAX_DELAY_MS: '1',
      // Keep the failing deployment in play, so every call is a real attempt.
      BREAKER_FAILURE_THRESHOLD: '1000',
    }),
    captureLogger().logger,
    { models },
  );
  gateway.app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'GET') routes.push(route.url);
    }
  });
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  const db = gateway.db;
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: pricedModel,
      input_micro_usd_per_mtok: 2_000_000,
      output_micro_usd_per_mtok: 8_000_000,
      effective_from: new Date('2020-01-01T00:00:00Z'),
    })
    .execute();

  const projectA = await createProject(db);
  const projectB = await createProject(db);
  const owner = await createUser(db, [{ projectId: projectA, role: 'owner' }]);
  const keyA = await createApiKey(db, projectA);
  const limitedKey = await createApiKey(db, projectA);
  await db.updateTable('api_keys').set({ rpm_limit: 1 }).where('id', '=', limitedKey.id).execute();
  const keyB = await createApiKey(db, projectB);
  const prompt = `PROMPT-MARKER-${randomBytes(6).toString('hex')}`;

  const requestIds: string[] = [];
  for (let i = 0; i < 3; i++) requestIds.push(await chat(keyA.plaintext, 'm-ok', prompt));
  requestIds.push(await chat(keyA.plaintext, 'm-broken', prompt));
  requestIds.push(await chat(keyA.plaintext, 'm-failover', prompt));
  // One admitted, two rejected by the 1-per-minute limit.
  for (let i = 0; i < 3; i++) requestIds.push(await chat(limitedKey.plaintext, 'm-ok', prompt));
  // Another project's traffic, which A's owner must never see.
  await chat(keyB.plaintext, 'm-ok', prompt);

  f = {
    projectA,
    projectB,
    owner,
    cookie: await login(owner),
    keyA,
    limitedKey,
    keyB,
    prompt,
    requestIds,
  };
  // Wait until the worker has ingested all of A's requests.
  await vi.waitFor(
    async () => {
      const { body } = await get<{ totals: { requests: number } }>(
        `/admin/analytics/overview?projectId=${projectA}&range=1h`,
      );
      expect(body.totals.requests).toBe(requestIds.length);
    },
    { timeout: 15_000, interval: 100 },
  );
  // A budget the traffic above already used up. Set afterwards: with it, each request's worst-case
  // reservation would have been refused.
  await db
    .updateTable('projects')
    .set({ monthly_budget_micro_usd: 1 })
    .where('id', '=', projectA)
    .execute();
});

afterAll(async () => {
  await gateway.shutdown();
});

const sections = ['overview', 'requests', 'models', 'cost', 'reliability', 'security', 'infra'];

describe('analytics ranges', () => {
  it('rejects an unsupported range with the supported list', async () => {
    for (const section of sections) {
      const res = await get(`/admin/analytics/${section}?range=2h`);
      expect(res.status).toBe(400);
      const { error } = res.body as { error: { code: string; param: string; message: string } };
      expect(error).toMatchObject({ code: 'unsupported_range', param: 'range' });
      expect(error.message).toContain('1h, 24h, 7d, 30d');
    }
  });

  it('reads minute rollups for 1h and 24h, hourly for 7d and daily for 30d', async () => {
    const expected = { '1h': 'minute', '24h': 'minute', '7d': 'hour', '30d': 'day' } as const;
    for (const range of ANALYTICS_RANGES) {
      const { body } = await get<{ window: { granularity: string }; totals: { requests: number } }>(
        `/admin/analytics/overview?projectId=${f.projectA}&range=${range}`,
      );
      expect(body.window.granularity).toBe(expected[range]);
      // Each table holds the same requests.
      expect(body.totals.requests).toBe(f.requestIds.length);
    }
  });
});

describe('analytics isolation', () => {
  it("answers 404 for another project's id on every section", async () => {
    for (const section of sections) {
      const res = await get(`/admin/analytics/${section}?projectId=${f.projectB}`);
      expect({
        section,
        status: res.status,
        code: (res.body as { error?: { code: string } }).error?.code,
      }).toEqual({
        section,
        status: 404,
        code: 'project_not_found',
      });
    }
  });

  it("never includes another project's requests", async () => {
    const list = await get<{ data: { projectId: string }[] }>(
      '/admin/analytics/requests?limit=100',
    );
    expect(new Set(list.body.data.map((r) => r.projectId))).toEqual(new Set([f.projectA]));
    const cost = await get<{ byProject: { projectId: string }[] }>('/admin/analytics/cost');
    expect(cost.body.byProject.map((p) => p.projectId)).toEqual([f.projectA]);
    // A filter on another project's key matches nothing rather than reaching into it.
    const other = await get<{ totals: { requests: number } }>(
      `/admin/analytics/overview?apiKeyId=${f.keyB.id}`,
    );
    expect(other.body.totals.requests).toBe(0);
  });
});

interface RequestRow {
  id: string;
  status: string;
  model: string;
  apiKeyId: string | null;
  costMicroUsd: number | null;
  totalTokens: number | null;
}

describe('analytics sections', () => {
  const q = () => `projectId=${f.projectA}&range=1h`;

  it('overview totals and series match the request list', async () => {
    const list = (await get<{ data: RequestRow[] }>(`/admin/analytics/requests?${q()}&limit=100`))
      .body.data;
    expect(list.map((r) => r.id).sort()).toEqual([...f.requestIds].sort());
    const { body } = await get<{
      totals: Record<string, unknown> & { latencyMs: { p50: number | null; p95: number | null } };
      series: { requests: number; rejected: number }[];
    }>(`/admin/analytics/overview?${q()}`);
    const count = (status: string) => list.filter((r) => r.status === status).length;
    expect(body.totals).toMatchObject({
      requests: 8,
      succeeded: count('success'),
      failed: count('error'),
      rejected: 2,
      costMicroUsd: list.reduce((sum, r) => sum + (r.costMicroUsd ?? 0), 0),
      totalTokens: list.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0),
    });
    expect(count('success')).toBe(5);
    expect(count('error')).toBe(1);
    expect(body.totals.latencyMs.p50).not.toBeNull();
    expect(body.series).toHaveLength(60);
    expect(body.series.reduce((sum, p) => sum + p.requests, 0)).toBe(8);
    expect(body.series.reduce((sum, p) => sum + p.rejected, 0)).toBe(2);
  });

  it('applies the key, model, provider and status filters', async () => {
    const totals = async (filter: string) =>
      (await get<{ totals: { requests: number } }>(`/admin/analytics/overview?${q()}&${filter}`))
        .body.totals.requests;
    expect(await totals(`apiKeyId=${f.limitedKey.id}`)).toBe(3);
    expect(await totals('model=m-broken')).toBe(1);
    expect(await totals('status=rejected')).toBe(2);
    expect(await totals('provider=mock')).toBe(6);
    const page = await get<{ data: RequestRow[] }>(
      `/admin/analytics/requests?${q()}&status=rejected`,
    );
    expect(page.body.data.map((r) => r.apiKeyId)).toEqual([f.limitedKey.id, f.limitedKey.id]);
  });

  it('models compares deployments', async () => {
    const { body } = await get<{
      data: { model: string; deployment: string | null; metrics: Record<string, number | null> }[];
    }>(`/admin/analytics/models?${q()}`);
    const row = (model: string) =>
      body.data.find((r) => r.model === model && r.deployment !== null)!;
    expect(row('m-ok').metrics).toMatchObject({ requests: 4, succeeded: 4, errorRate: 0 });
    expect(row('m-broken').metrics).toMatchObject({
      requests: 1,
      failed: 1,
      errorRate: 1,
      retries: 1,
    });
    expect(row('m-failover').metrics).toMatchObject({
      requests: 1,
      succeeded: 1,
      fallbacks: 1,
      fallbackRate: 1,
    });
    expect(row('m-ok').metrics.outputTokensPerSecond).toBeGreaterThan(0);
  });

  it('cost breaks spend down and flags the budget', async () => {
    const { body } = await get<{
      totals: { costMicroUsd: number };
      byProvider: { provider: string | null; costMicroUsd: number }[];
      byApiKey: { apiKeyId: string | null; name: string | null; requests: number }[];
      budgets: { projectId: string; budgetMicroUsd: number; alert: string; period: string }[];
      projection: { monthlyCostMicroUsd: number | null; reason: string | null };
      series: { costMicroUsd: number }[];
    }>(`/admin/analytics/cost?${q()}`);
    expect(body.totals.costMicroUsd).toBeGreaterThan(0);
    expect(body.byProvider.find((p) => p.provider === 'mock')?.costMicroUsd).toBe(
      body.totals.costMicroUsd,
    );
    expect(body.series.reduce((sum, p) => sum + p.costMicroUsd, 0)).toBe(body.totals.costMicroUsd);
    expect(body.byApiKey.find((k) => k.apiKeyId === f.limitedKey.id)).toMatchObject({
      name: 'test',
      requests: 3,
    });
    expect(body.budgets).toEqual([
      expect.objectContaining({
        projectId: f.projectA,
        budgetMicroUsd: 1,
        period: budgetPeriodAt(Date.now()).key,
        alert: 'exceeded',
      }),
    ]);
    expect(body.projection).toMatchObject({ monthlyCostMicroUsd: null, daysOfData: 0 });
    expect(body.projection.reason).toContain('7 full days');
  });

  it('reliability shows errors, retries, fallbacks and breaker states', async () => {
    const { body } = await get<{
      totals: { retries: number; fallbacks: number; failed: number };
      errorsByCode: { errorCode: string | null; requests: number }[];
      breakers: { deployment: string }[] | null;
    }>(`/admin/analytics/reliability?${q()}`);
    expect(body.totals).toMatchObject({ retries: 2, fallbacks: 1, failed: 1 });
    expect(body.errorsByCode).toEqual([
      { status: 'error', errorCode: 'upstream_error', requests: 1 },
    ]);
    expect(body.breakers?.map((b) => b.deployment).sort()).toEqual([broken, ok].sort());
  });

  it('security counts rejections by reason', async () => {
    const { body } = await get<{
      rejected: number;
      byCategory: { category: string; requests: number }[];
      byApiKey: { apiKeyId: string | null; requests: number }[];
      invalidApiKeys: { count: null };
    }>(`/admin/analytics/security?${q()}`);
    expect(body.rejected).toBe(2);
    expect(body.byCategory.find((c) => c.category === 'rate_limit')?.requests).toBe(2);
    expect(body.byApiKey).toEqual([{ apiKeyId: f.limitedKey.id, name: 'test', requests: 2 }]);
    expect(body.invalidApiKeys.count).toBeNull();
    const none = await get<{ rejected: number }>(`/admin/analytics/security?${q()}&status=success`);
    expect(none.body.rejected).toBe(0);
  });

  it('infra measures the pipeline and dependencies', async () => {
    const { body } = await get<{
      pipeline: { streamLength: number; pendingEvents: number; deadLetterLength: number } | null;
      dependencies: Record<string, { status: string }>;
    }>(`/admin/analytics/infra?${q()}`);
    expect(body.pipeline).toMatchObject({ deadLetterLength: 0 });
    expect(body.pipeline!.streamLength).toBeGreaterThanOrEqual(0);
    expect(body.dependencies).toMatchObject({
      postgres: { status: 'ok' },
      redis: { status: 'ok' },
    });
  });
});

describe('monthly spend projection', () => {
  it('projects from 7 full days of data: spend so far plus the daily average for the days left', async () => {
    const db = gateway.db;
    const project = await createProject(db);
    const user = await createUser(db, [{ projectId: project, role: 'viewer' }]);
    const cookie = await login(user);
    const day = 86_400_000;
    const now = Date.now();
    const today = Math.floor(now / day) * day;
    // One request per day for the last 10 days, each costing 1000 + day index micro-dollars.
    const events: UsageEvent[] = [];
    const costs = new Map<number, number>();
    for (let d = 1; d <= 10; d++) {
      const start = today - d * day + 3_600_000;
      // 1000 output tokens at 8 $/Mtok = 8000 micro-dollars, plus d prompt tokens' worth.
      const promptTokens = d * 500;
      costs.set(start, Math.ceil((promptTokens * 2_000_000 + 1_000 * 8_000_000) / 1_000_000));
      events.push({
        v: 1,
        type: 'request.completed',
        eventId: uuidv7(start + 10),
        occurredAt: new Date(start + 10).toISOString(),
        request: {
          id: uuidv7(start),
          projectId: project,
          apiKeyId: null,
          model: 'm-ok',
          deployment: ok,
          stream: false,
          status: 'success',
          httpStatus: 200,
          errorCode: null,
          startedAt: new Date(start).toISOString(),
          completedAt: new Date(start + 10).toISOString(),
          latencyMs: 10,
          ttftMs: null,
        },
        attempts: [
          {
            id: uuidv7(start),
            attemptNumber: 1,
            deployment: ok,
            provider: 'mock',
            providerModel: pricedModel,
            outcome: 'success',
            upstreamStatus: null,
            routingPolicy: null,
            routingReason: null,
            startedAt: new Date(start).toISOString(),
            completedAt: new Date(start + 10).toISOString(),
            latencyMs: 10,
            ttftMs: null,
          },
        ],
        usage: { promptTokens, completionTokens: 1_000, totalTokens: promptTokens + 1_000 },
        usageSource: 'reported',
      });
    }
    await db.transaction().execute((trx) => ingestEvents(trx, events));

    const { body } = await get<{
      projection: { monthlyCostMicroUsd: number | null; reason: string | null; daysOfData: number };
    }>(`/admin/analytics/cost?projectId=${project}&range=30d`, cookie);
    const period = budgetPeriodAt(now);
    const sumWhere = (keep: (start: number) => boolean) =>
      [...costs].filter(([start]) => keep(start)).reduce((sum, [, cost]) => sum + cost, 0);
    const lastWeek = sumWhere((start) => start >= today - 7 * day);
    const monthToDate = sumWhere((start) => start >= period.start);
    const expected = monthToDate + (lastWeek / 7) * ((period.end - now) / day);
    expect(body.projection.reason).toBeNull();
    expect(body.projection.daysOfData).toBe(10);
    expect(body.projection.monthlyCostMicroUsd).not.toBeNull();
    expect(Math.abs(body.projection.monthlyCostMicroUsd! - expected)).toBeLessThan(2);
  });
});

describe('response scanner', () => {
  it('finds no key hashes, keys, passwords, prompts or stack traces in any admin response', async () => {
    const db = gateway.db;
    const keys = await db
      .selectFrom('api_keys')
      .select(['secret_hash'])
      .where('project_id', '=', f.projectA)
      .execute();
    const passwordHash = (
      await db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', f.owner.id)
        .executeTakeFirstOrThrow()
    ).password_hash;
    const forbidden: [string, string | RegExp][] = [
      ['prompt', f.prompt],
      ['api key', f.keyA.plaintext],
      ['api key secret', f.keyA.plaintext.split('_')[2]!],
      ['limited key', f.limitedKey.plaintext],
      ['password', f.owner.password],
      ['password hash', passwordHash],
      ['argon2 hash', '$argon2'],
      ['pepper', TEST_PEPPER],
      ['stack frame', /\bat [\w.<>]+ \(|\bat (file:|node:)/],
      ['source location', /\.(ts|js):\d+:\d+/],
      ['node_modules path', 'node_modules'],
      ...keys.flatMap((k): [string, string][] => [
        ['key hash (hex)', k.secret_hash.toString('hex')],
        ['key hash (base64)', k.secret_hash.toString('base64')],
        ['key hash (base64url)', k.secret_hash.toString('base64url')],
      ]),
    ];

    // Every GET admin route, with its parameters filled in.
    const adminGets = [...new Set(routes.filter((r) => r.startsWith('/admin/')))];
    const fill = (route: string) =>
      route.replace(':projectId', f.projectA).replace(':requestId', f.requestIds.at(-4)!);
    const paths = adminGets.map(fill);
    for (const section of sections) {
      for (const range of ANALYTICS_RANGES)
        paths.push(`/admin/analytics/${section}?range=${range}`);
    }
    for (const id of f.requestIds) paths.push(`/admin/requests/${id}`);
    // Error responses too.
    paths.push(
      '/admin/analytics/overview?range=bogus',
      '/admin/analytics/requests?cursor=bm9wZQ',
      '/admin/analytics/overview?status=bogus',
      `/admin/analytics/cost?projectId=${f.projectB}`,
      `/admin/requests/${uuidv7()}`,
      '/admin/requests/not-a-uuid',
    );

    const scanned = new Set<string>();
    for (const path of paths) {
      const res = await get(path);
      expect(res.status, path).toBeLessThan(500);
      for (const [what, pattern] of forbidden) {
        const found =
          typeof pattern === 'string' ? res.text.includes(pattern) : pattern.test(res.text);
        expect(found, `${what} in ${path}`).toBe(false);
      }
      scanned.add(path.split('?')[0]!);
    }
    // Nothing was skipped: each registered GET admin route was requested.
    for (const route of adminGets) expect(scanned.has(fill(route)), route).toBe(true);
    expect(adminGets.length).toBeGreaterThan(10);
  });
});
