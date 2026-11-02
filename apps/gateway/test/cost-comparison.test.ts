import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { databasePriceLoader } from '../src/limits/prices.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/**
 * Reference prices (M11) are for the cost comparison only. Here the deployment's own model has
 * only a reference price: it must stay unpriced for routing, budgets and the worker.
 */
const tag = randomBytes(4).toString('hex');
const pricedModel = `cmp-priced-${tag}`;
const referenceOnly = `cmp-reference-${tag}`;
const elsewhere = `cmp-elsewhere-${tag}`;

const models = parseModelsConfig(
  {
    deployments: {
      priced: { adapter: 'mock', model: pricedModel, mock: { completionTokens: 10 } },
      unpriced: { adapter: 'mock', model: referenceOnly, mock: { completionTokens: 10 } },
    },
    models: {
      'cmp-priced': { deployment: 'priced' },
      'cmp-unpriced': { deployment: 'unpriced' },
      // Cost-aware between the two: a reference price must not make `unpriced` look costly.
      'cmp-cheapest': {
        policy: 'cost_aware',
        targets: [{ deployment: 'priced' }, { deployment: 'unpriced' }],
      },
    },
  },
  'cost-comparison-test',
);

let gateway: Gateway;
let url: string;
let key: string;
let cookie: string;
let projectId: string;

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:cmp:${tag}`,
      EVENTS_DLQ_STREAM: `test:cmp:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `cmp-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  const since = new Date(Date.now() - 60_000);
  const price = (model: string, input: number, output: number, reference: boolean) => ({
    id: uuidv7(),
    provider: 'mock',
    model,
    input_micro_usd_per_mtok: input,
    output_micro_usd_per_mtok: output,
    effective_from: since,
    reference,
  });
  await gateway.db
    .insertInto('model_prices')
    .values([
      price(pricedModel, 1_000_000, 2_000_000, false),
      price(referenceOnly, 50_000_000, 50_000_000, true),
      price(elsewhere, 100_000_000, 100_000_000, true),
    ])
    .execute();
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  projectId = await createProject(gateway.db);
  key = (await createApiKey(gateway.db, projectId)).plaintext;
  const user = await createUser(gateway.db, [{ projectId, role: 'viewer' }]);
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await gateway?.shutdown();
});

async function chat(model: string) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello' }] }),
  });
  await res.text();
  return {
    requestId: res.headers.get('x-request-id')!,
    deployment: res.headers.get('x-gateway-deployment'),
  };
}

async function usageOf(requestId: string) {
  let usage: { costMicroUsd: number | null; priceId: string | null } | null | undefined;
  await vi.waitFor(
    async () => {
      const res = await fetch(`${url}/admin/requests/${requestId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      usage = ((await res.json()) as { usage: typeof usage }).usage;
      expect(usage).not.toBeNull();
    },
    { timeout: 10_000, interval: 100 },
  );
  return usage!;
}

describe('reference prices', () => {
  it('are never loaded into the price book that routing and budgets use', async () => {
    const rows = await databasePriceLoader(gateway.db)();
    expect(rows.some((r) => r.model === pricedModel)).toBe(true);
    expect(rows.some((r) => r.model === referenceOnly || r.model === elsewhere)).toBe(false);
  });

  it('never cost a request, and never steer cost-aware routing', async () => {
    const unpriced = await chat('cmp-unpriced');
    expect(await usageOf(unpriced.requestId)).toMatchObject({ costMicroUsd: null, priceId: null });
    // Unpriced counts as free for cost-aware ordering, as before: the reference price is ignored.
    expect((await chat('cmp-cheapest')).deployment).toBe('unpriced');
  });
});

describe('GET /admin/analytics/cost-comparison', () => {
  it("prices the range's tokens under every priced model, cheapest first, with a note", async () => {
    const served = await chat('cmp-priced');
    const used = await usageOf(served.requestId);
    expect(used.costMicroUsd).toBeGreaterThan(0);

    let body:
      | {
          promptTokens: number;
          completionTokens: number;
          actualCostMicroUsd: number;
          note: string;
          models: {
            provider: string;
            model: string;
            reference: boolean;
            costMicroUsd: number;
          }[];
        }
      | undefined;
    await vi.waitFor(
      async () => {
        const res = await fetch(
          `${url}/admin/analytics/cost-comparison?range=1h&projectId=${projectId}`,
          { headers: { cookie } },
        );
        expect(res.status).toBe(200);
        body = (await res.json()) as NonNullable<typeof body>;
        expect(body.completionTokens).toBeGreaterThanOrEqual(30);
      },
      { timeout: 10_000, interval: 200 },
    );
    const { promptTokens, completionTokens, models: priced, note } = body!;
    const at = (input: number, output: number) =>
      Math.ceil((promptTokens * input + completionTokens * output) / 1_000_000);
    const find = (model: string) => priced.find((m) => m.model === model);
    expect(find(pricedModel)).toMatchObject({
      reference: false,
      costMicroUsd: at(1_000_000, 2_000_000),
    });
    expect(find(elsewhere)).toMatchObject({
      reference: true,
      costMicroUsd: at(100_000_000, 100_000_000),
    });
    const costs = priced.map((m) => m.costMicroUsd);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    expect(note).toMatch(/tokenizer/);
  });
});
