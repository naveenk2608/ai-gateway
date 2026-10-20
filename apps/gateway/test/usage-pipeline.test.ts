import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/** A provider model name of its own, so its price row affects no other test. */
const pricedModel = `priced-${randomBytes(3).toString('hex')}`;
const models = parseModelsConfig(
  {
    deployments: {
      priced: { provider: 'mock', model: pricedModel, mock: { completionTokens: 4 } },
      dropping: {
        provider: 'mock',
        model: pricedModel,
        mock: { completionTokens: 10, dropAfterTokens: 2 },
      },
      failing: { provider: 'mock', model: pricedModel, mock: { failWith: 500 } },
    },
    models: {
      'mock-priced': { deployment: 'priced' },
      'mock-dropping': { deployment: 'dropping' },
      'mock-failing': { deployment: 'failing' },
    },
  },
  'pipeline-test',
);

let gateway: Gateway;
let url: string;
let key: string;
let cookie: string;
let otherCookie: string;
let projectId: string;
const tag = randomBytes(4).toString('hex');

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:pipeline:${tag}`,
      EVENTS_DLQ_STREAM: `test:pipeline:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `pipeline-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;

  const db = gateway.db;
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: pricedModel,
      input_micro_usd_per_mtok: 1_000_000, // $1 per million prompt tokens
      output_micro_usd_per_mtok: 2_000_000,
      effective_from: new Date(Date.now() - 60_000),
    })
    .execute();
  projectId = await createProject(db);
  key = (await createApiKey(db, projectId)).plaintext;
  const owner = await createUser(db, [{ projectId, role: 'viewer' }]);
  const outsider = await createUser(db, [{ projectId: await createProject(db), role: 'owner' }]);
  const login = async (u: { email: string; password: string }) => {
    const res = await fetch(`${url}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: u.password }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
  };
  cookie = await login(owner);
  otherCookie = await login(outsider);
});

afterAll(async () => {
  await gateway.shutdown();
});

async function chat(model: string, stream = false): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Say hello' }] }),
  });
  await res.text();
  return res.headers.get('x-request-id')!;
}

interface Detail {
  status: string;
  httpStatus: number;
  errorCode: string | null;
  usage: { source: string; totalTokens: number | null; costMicroUsd: number | null } | null;
  attempts: { id: string; attemptNumber: number; outcome: string; deployment: string }[];
}

/** Polls until the worker has written the request. */
async function detail(requestId: string, as = cookie): Promise<Detail> {
  let body: Detail | undefined;
  await vi.waitFor(
    async () => {
      const res = await fetch(`${url}/admin/requests/${requestId}`, { headers: { cookie: as } });
      expect(res.status).toBe(200);
      body = (await res.json()) as Detail;
    },
    { timeout: 10_000, interval: 100 },
  );
  return body!;
}

describe('usage pipeline with the worker running in the gateway process', () => {
  it('records a completed request with its attempt, reported usage and cost', async () => {
    const id = await chat('mock-priced');
    const d = await detail(id);
    expect(d).toMatchObject({ status: 'success', httpStatus: 200, errorCode: null });
    // The mock reports 3 prompt tokens ("Say hello") and 4 completion tokens:
    // 3 x $1/M + 4 x $2/M = 11 micro-dollars.
    expect(d.usage).toMatchObject({ source: 'reported', totalTokens: 7, costMicroUsd: 11 });
    expect(d.attempts).toEqual([
      expect.objectContaining({ attemptNumber: 1, outcome: 'success', deployment: 'priced' }),
    ]);
  });

  it('records an interrupted stream with estimated usage', async () => {
    const d = await detail(await chat('mock-dropping', true));
    expect(d).toMatchObject({
      status: 'error',
      httpStatus: 200,
      errorCode: 'upstream_unavailable',
    });
    expect(d.usage?.source).toBe('estimated');
    expect(d.attempts[0]?.outcome).toBe('connection');
  });

  it('records a failed request with missing usage and no cost', async () => {
    const d = await detail(await chat('mock-failing'));
    expect(d).toMatchObject({ status: 'error', httpStatus: 502, errorCode: 'upstream_error' });
    expect(d.usage).toMatchObject({ source: 'missing', totalTokens: null, costMicroUsd: null });
  });

  it("returns 404 for another project's request, and for an unknown one", async () => {
    const id = await chat('mock-priced');
    await detail(id); // processed
    const other = await fetch(`${url}/admin/requests/${id}`, { headers: { cookie: otherCookie } });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: { code: 'request_not_found' } });
    const unknown = await fetch(`${url}/admin/requests/${uuidv7()}`, { headers: { cookie } });
    expect(unknown.status).toBe(404);
  });

  it('keeps the request ID from ingress through to the stored record', async () => {
    const id = await chat('mock-priced');
    const { attempts } = await detail(id);
    const row = await gateway.db
      .selectFrom('usage_events')
      .innerJoin('provider_attempts', 'provider_attempts.request_id', 'usage_events.request_id')
      .select(['usage_events.request_id', 'provider_attempts.id as attemptId'])
      .where('usage_events.request_id', '=', id)
      .executeTakeFirstOrThrow();
    // The x-request-id the client saw, and the attemptId from the logs, are the stored keys.
    expect(row).toEqual({ request_id: id, attemptId: attempts[0]?.id });
  });
});

interface Summary {
  id: string;
  startedAt: string;
  status: string;
  costMicroUsd: number | null;
}

async function page(query: string): Promise<{ data: Summary[]; nextCursor: string | null }> {
  const res = await fetch(`${url}/admin/projects/${projectId}/requests${query}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Summary[]; nextCursor: string | null };
}

describe('request list and overview for the dashboard', () => {
  it('pages through every request, newest first, without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await chat('mock-priced'));
    await detail(ids.at(-1)!);
    await vi.waitFor(async () => {
      const all = (await page('?limit=100')).data.map((r) => r.id);
      expect(all).toEqual(expect.arrayContaining(ids));
    });

    const everything = (await page('?limit=100')).data;
    const seen: Summary[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const next = await page(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(next.data.length).toBeLessThanOrEqual(2);
      seen.push(...next.data);
      cursor = next.nextCursor;
    }
    expect(seen.map((r) => r.id)).toEqual(everything.map((r) => r.id));
    const order = [...seen].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    );
    expect(seen).toEqual(order);
  });

  it('rejects a forged cursor', async () => {
    const res = await fetch(`${url}/admin/projects/${projectId}/requests?cursor=bm9wZQ`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_cursor' } });
  });

  it('sums the last 24 hours from the stored requests', async () => {
    await detail(await chat('mock-priced'));
    const list = (await page('?limit=100')).data;
    const res = await fetch(`${url}/admin/projects/${projectId}/overview`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const overview = (await res.json()) as Record<string, unknown>;
    expect(overview).toMatchObject({
      requests: list.length,
      succeeded: list.filter((r) => r.status === 'success').length,
      failed: list.filter((r) => r.status === 'error').length,
      costMicroUsd: list.reduce((sum, r) => sum + (r.costMicroUsd ?? 0), 0),
      month: { budgetMicroUsd: null },
    });
    expect((overview.month as { spentMicroUsd: number }).spentMicroUsd).toBe(overview.costMicroUsd);
  });
});
