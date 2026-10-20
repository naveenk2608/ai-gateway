/**
 * M6 acceptance: every analytics endpoint answers a valid empty response on an empty database.
 * The gateway runs against a throwaway database migrated from scratch, holding only the user who
 * logs in, and against usage streams no other test writes to.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ANALYTICS_RANGES } from '@ai-gateway/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createProject, createUser, type TestUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

const tag = randomBytes(4).toString('hex');
const dbName = `gw_empty_${tag}`;
const adminUrl = process.env.DATABASE_URL!;
const emptyUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();

async function admin(query: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

const models = parseModelsConfig(
  {
    deployments: { [`empty-${tag}`]: { provider: 'mock' } },
    models: { 'mock-empty': { deployment: `empty-${tag}` } },
  },
  'analytics-empty',
);

let gateway: Gateway;
let url: string;

async function login(user: TestUser): Promise<string> {
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

beforeAll(async () => {
  await admin(`CREATE DATABASE ${dbName}`);
  gateway = createGateway(
    testConfig({
      DATABASE_URL: emptyUrl,
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:empty:${tag}`,
      EVENTS_DLQ_STREAM: `test:empty:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `empty-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  // Applies every migration to the new database.
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway?.shutdown();
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

const zeroMetrics = {
  requests: 0,
  succeeded: 0,
  failed: 0,
  rejected: 0,
  canceled: 0,
  cacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  attempts: 0,
  retries: 0,
  fallbacks: 0,
  errorRate: null,
  fallbackRate: null,
  latencyMs: { avg: null, p50: null, p95: null, p99: null },
  ttftMs: { avg: null, p50: null, p95: null, p99: null },
  outputTokensPerSecond: null,
};

const SERIES_POINTS = { '1h': 60, '24h': 96, '7d': 168, '30d': 30 } as const;

type Body = Record<string, unknown> & { series?: Record<string, unknown>[] };

async function get(path: string, cookie: string): Promise<Body> {
  const res = await fetch(`${url}${path}`, { headers: { cookie } });
  expect(res.status, path).toBe(200);
  return (await res.json()) as Body;
}

/** Every series point is zero, and there is one per step of the range. */
function expectZeroSeries(body: Body, range: keyof typeof SERIES_POINTS) {
  expect(body.series).toHaveLength(SERIES_POINTS[range]);
  for (const point of body.series ?? []) {
    for (const [field, value] of Object.entries(point)) {
      if (field !== 'start') expect(value, field).toBe(0);
    }
  }
}

describe('analytics on an empty database', () => {
  it('answers every section, for every range, with zeros and empty lists', async () => {
    const db = gateway.db;
    expect(await db.selectFrom('request_records').select('id').execute()).toEqual([]);
    const projectId = await createProject(db);
    const user = await createUser(db, [{ projectId, role: 'viewer' }]);
    const cookie = await login(user);

    for (const range of ANALYTICS_RANGES) {
      for (const scope of ['', `&projectId=${projectId}`]) {
        const q = `range=${range}${scope}`;

        const overview = await get(`/admin/analytics/overview?${q}`, cookie);
        expect(overview.totals).toEqual(zeroMetrics);
        expect(overview.month).toMatchObject({ spentMicroUsd: 0 });
        expectZeroSeries(overview, range);

        expect(await get(`/admin/analytics/requests?${q}`, cookie)).toMatchObject({
          data: [],
          nextCursor: null,
        });
        expect(await get(`/admin/analytics/models?${q}`, cookie)).toMatchObject({ data: [] });

        const cost = await get(`/admin/analytics/cost?${q}`, cookie);
        expect(cost).toMatchObject({
          totals: { requests: 0, totalTokens: 0, costMicroUsd: 0, promptTokens: 0 },
          byProvider: [],
          byModel: [],
          byProject: [],
          byApiKey: [],
          budgets: [
            {
              projectId,
              spentMicroUsd: 0,
              budgetMicroUsd: null,
              usedShare: null,
              alert: null,
            },
          ],
          projection: { monthlyCostMicroUsd: null, daysOfData: 0 },
        });
        expectZeroSeries(cost, range);

        const reliability = await get(`/admin/analytics/reliability?${q}`, cookie);
        expect(reliability).toMatchObject({
          totals: zeroMetrics,
          errorsByCode: [],
          byDeployment: [],
          healthEvents: [],
          breakers: [{ deployment: `empty-${tag}`, instances: [] }],
        });
        expectZeroSeries(reliability, range);

        const security = await get(`/admin/analytics/security?${q}`, cookie);
        expect(security).toMatchObject({ rejected: 0, byCode: [], byApiKey: [] });
        expect((security.byCategory as { requests: number }[]).every((c) => c.requests === 0)).toBe(
          true,
        );
        expectZeroSeries(security, range);

        expect(await get(`/admin/analytics/infra?${q}`, cookie)).toMatchObject({
          pipeline: {
            streamLength: 0,
            unreadEvents: 0,
            pendingEvents: 0,
            oldestPendingAgeMs: null,
            deadLetterLength: 0,
          },
          failedEvents: { total: 0, inWindow: 0 },
          dependencies: { postgres: { status: 'ok' }, redis: { status: 'ok' } },
        });
      }
    }
  });

  it('answers a user who belongs to no project with empty results', async () => {
    const cookie = await login(await createUser(gateway.db));
    const overview = await get('/admin/analytics/overview', cookie);
    expect(overview.totals).toEqual(zeroMetrics);
    expect(await get('/admin/analytics/requests', cookie)).toMatchObject({ data: [] });
    expect(await get('/admin/analytics/cost', cookie)).toMatchObject({
      byProject: [],
      budgets: [],
    });
  });
});
