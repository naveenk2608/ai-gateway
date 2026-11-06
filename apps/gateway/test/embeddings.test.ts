import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import OpenAI, { BadRequestError, RateLimitError } from 'openai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/**
 * /v1/embeddings end to end (M13, ADR 029): the official OpenAI SDK against the gateway and the
 * mock, then limits, the budget, the cache, and the request record the worker stores.
 */
const tag = randomBytes(4).toString('hex');
/** A provider model name of its own, so its price row affects no other test. */
const embedModel = `embed-${tag}`;
const models = parseModelsConfig(
  {
    deployments: {
      embed: {
        adapter: 'mock',
        type: 'embeddings',
        model: embedModel,
        embedding: { dimensions: 32, dimensionsRange: { min: 8, max: 32 } },
      },
      'embed-cached': {
        adapter: 'mock',
        type: 'embeddings',
        model: embedModel,
        embedding: { dimensions: 32 },
      },
    },
    models: {
      'mock-embed': { deployment: 'embed' },
      'mock-embed-cached': { deployment: 'embed-cached' },
    },
  },
  'embeddings-int',
);

let gateway: Gateway;
let url: string;
let client: OpenAI;
let projectId: string;
let cookie: string;

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      CACHE_ENABLED: 'true',
      EVENTS_STREAM: `test:embeddings:${tag}`,
      EVENTS_DLQ_STREAM: `test:embeddings:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `embeddings-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  await gateway.db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: embedModel,
      // $1 per million input tokens and no output price, as embedding prices are.
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 0,
      effective_from: new Date(Date.now() - 60_000),
    })
    .execute();
  // The price book loads at startup; reload it so the new row prices the budget reservation.
  await gateway.prices.refresh();
  projectId = await createProject(gateway.db);
  const key = await createApiKey(gateway.db, projectId);
  client = new OpenAI({ baseURL: `${url}/v1`, apiKey: key.plaintext, maxRetries: 0 });
  const viewer = await createUser(gateway.db, [{ projectId, role: 'viewer' }]);
  const login = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: viewer.email, password: viewer.password }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await gateway.shutdown();
});

const norm = (v: number[]) => Math.sqrt(v.reduce((n, x) => n + x * x, 0));

async function rawEmbed(key: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: { code: string } };
  return { res, json, id: res.headers.get('x-request-id')! };
}

describe('embeddings with the OpenAI SDK', () => {
  it('embeds one input (the SDK asks for base64 and decodes it)', async () => {
    const answer = await client.embeddings.create({ model: 'mock-embed', input: 'hello world' });
    expect(answer.object).toBe('list');
    expect(answer.model).toBe('mock-embed');
    expect(answer.data).toHaveLength(1);
    const vector = answer.data[0]!.embedding;
    expect(vector).toHaveLength(32);
    expect(norm(vector)).toBeCloseTo(1, 5);
    expect(answer.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('embeds a batch in order, the same input giving the same vector', async () => {
    const answer = await client.embeddings.create({
      model: 'mock-embed',
      input: ['first', 'second', 'first'],
      encoding_format: 'float',
    });
    expect(answer.data.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(answer.data[0]!.embedding).toEqual(answer.data[2]!.embedding);
    expect(answer.data[0]!.embedding).not.toEqual(answer.data[1]!.embedding);
  });

  it('returns base64 when asked, matching the floats', async () => {
    const floats = await client.embeddings.create({
      model: 'mock-embed',
      input: 'same text',
      encoding_format: 'float',
    });
    const encoded = await client.embeddings.create({
      model: 'mock-embed',
      input: 'same text',
      encoding_format: 'base64',
    });
    const text = encoded.data[0]!.embedding;
    expect(typeof text).toBe('string');
    const bytes = Buffer.from(text, 'base64');
    const decoded = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
    decoded.forEach((x, i) => expect(x).toBeCloseTo(floats.data[0]!.embedding[i]!, 6));
  });

  it('honours dimensions where the model allows them, and refuses token arrays', async () => {
    const answer = await client.embeddings.create({
      model: 'mock-embed',
      input: 'short',
      dimensions: 8,
    });
    expect(answer.data[0]!.embedding).toHaveLength(8);
    const error = await client.embeddings
      .create({ model: 'mock-embed', input: [1, 2, 3] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ status: 400, param: 'input' });
  });
});

describe('embeddings through limits, budgets, the cache and accounting', () => {
  it('is rate-limited per minute like chat', async () => {
    const limited = await createProject(gateway.db);
    await gateway.db
      .updateTable('projects')
      .set({ rpm_limit: 1 })
      .where('id', '=', limited)
      .execute();
    const sdk = new OpenAI({
      baseURL: `${url}/v1`,
      apiKey: (await createApiKey(gateway.db, limited)).plaintext,
      maxRetries: 0,
    });
    await sdk.embeddings.create({ model: 'mock-embed', input: 'one' });
    const error = await sdk.embeddings
      .create({ model: 'mock-embed', input: 'two' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ code: 'rpm_limit_exceeded' });
  });

  it("refuses a request whose input could cost more than the project's cap", async () => {
    const capped = await createProject(gateway.db);
    await gateway.db
      .updateTable('projects')
      .set({ monthly_budget_micro_usd: 1_000_000, max_request_cost_micro_usd: 5 })
      .where('id', '=', capped)
      .execute();
    const key = (await createApiKey(gateway.db, capped)).plaintext;
    // At $1 per million tokens, each token reserves one micro-dollar.
    const small = await rawEmbed(key, { model: 'mock-embed', input: 'one two' });
    expect(small.res.status).toBe(200);
    const large = await rawEmbed(key, { model: 'mock-embed', input: 'a b c d e f g h i j k l' });
    expect(large.res.status).toBe(400);
    expect(large.json.error?.code).toBe('request_exceeds_limit');
  });

  it('records the endpoint, tokens and cost, and counts the cost against the budget', async () => {
    const budgeted = await createProject(gateway.db);
    await gateway.db
      .updateTable('projects')
      .set({ monthly_budget_micro_usd: 1_000_000 })
      .where('id', '=', budgeted)
      .execute();
    const key = (await createApiKey(gateway.db, budgeted)).plaintext;
    const { res, id } = await rawEmbed(key, {
      model: 'mock-embed',
      input: ['alpha beta gamma', 'delta epsilon'],
    });
    expect(res.status).toBe(200);
    const usage = await vi.waitFor(
      async () => {
        const row = await gateway.db
          .selectFrom('usage_events')
          .selectAll()
          .where('request_id', '=', id)
          .executeTakeFirst();
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    const record = await gateway.db
      .selectFrom('request_records')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(record).toMatchObject({
      endpoint: 'embeddings',
      model: 'mock-embed',
      status: 'success',
    });
    expect(usage).toMatchObject({ usage_source: 'reported', completion_tokens: 0 });
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens);
    // $1 per million input tokens: one micro-dollar per token.
    expect(Number(usage.cost_micro_usd)).toBe(usage.prompt_tokens);

    const period = await vi.waitFor(
      async () => {
        const row = await gateway.db
          .selectFrom('budget_periods')
          .select('spent_micro_usd')
          .where('project_id', '=', budgeted)
          .executeTakeFirst();
        expect(Number(row?.spent_micro_usd ?? 0)).toBeGreaterThan(0);
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(Number(period.spent_micro_usd)).toBe(usage.prompt_tokens);
  });

  it('shows the endpoint in the admin request list and detail', async () => {
    const { id } = await rawEmbed((await createApiKey(gateway.db, projectId)).plaintext, {
      model: 'mock-embed',
      input: 'listed',
    });
    const detail = await vi.waitFor(
      async () => {
        const res = await fetch(`${url}/admin/requests/${id}`, { headers: { cookie } });
        expect(res.status).toBe(200);
        return (await res.json()) as { endpoint: string };
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(detail.endpoint).toBe('embeddings');
    const list = await fetch(
      `${url}/admin/analytics/requests?range=1h&projectId=${projectId}&limit=100`,
      { headers: { cookie } },
    );
    const page = (await list.json()) as { data: { id: string; endpoint: string }[] };
    expect(page.data.find((r) => r.id === id)?.endpoint).toBe('embeddings');
  });

  it('answers a repeated request from the cache, with no upstream call and no cost', async () => {
    const key = (await createApiKey(gateway.db, projectId)).plaintext;
    const body = { model: 'mock-embed-cached', input: [`cache me ${tag}`] };
    const first = await rawEmbed(key, body);
    expect(first.res.headers.get('x-gateway-cache')).toBe('miss');
    const second = await rawEmbed(key, body);
    expect(second.res.headers.get('x-gateway-cache')).toBe('hit');
    expect(second.json).toEqual(first.json);
    const mock = gateway.registry.deployment('embed-cached')?.provider as MockProvider;
    expect(mock.stats().requests).toBe(1);
    // A different encoding is a different entry.
    const base64 = await rawEmbed(key, { ...body, encoding_format: 'base64' });
    expect(base64.res.headers.get('x-gateway-cache')).toBe('miss');

    const usage = await vi.waitFor(
      async () => {
        const row = await gateway.db
          .selectFrom('usage_events')
          .select(['cost_micro_usd'])
          .where('request_id', '=', second.id)
          .executeTakeFirst();
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(Number(usage.cost_micro_usd)).toBe(0);
    const record = await gateway.db
      .selectFrom('request_records')
      .select(['cache_hit', 'endpoint'])
      .where('id', '=', second.id)
      .executeTakeFirstOrThrow();
    expect(record).toEqual({ cache_hit: true, endpoint: 'embeddings' });
  });

  it('lists the embeddings models in /v1/models', async () => {
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids).toEqual(expect.arrayContaining(['mock-embed', 'mock-embed-cached']));
  });
});
