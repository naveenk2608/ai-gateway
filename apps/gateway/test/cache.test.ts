import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

const tag = randomBytes(3).toString('hex');
const pricedModel = `cached-${tag}`;
const models = parseModelsConfig(
  {
    deployments: {
      cached: { provider: 'mock', model: pricedModel, mock: { completionTokens: 4 } },
    },
    models: { 'mock-cached': { deployment: 'cached' } },
  },
  'cache-test',
);

let gateway: Gateway;
let url: string;
const keys: Record<'a' | 'b', string> = { a: '', b: '' };
let cookieA: string;

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      CACHE_ENABLED: 'true',
      EVENTS_STREAM: `test:cache:${tag}`,
      EVENTS_DLQ_STREAM: `test:cache:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `cache-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  await gateway.db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: pricedModel,
      input_micro_usd_per_mtok: 1_000_000,
      output_micro_usd_per_mtok: 2_000_000,
      effective_from: new Date(0),
    })
    .execute();
  await gateway.prices.refresh();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  const a = await createProject(gateway.db);
  const b = await createProject(gateway.db);
  keys.a = (await createApiKey(gateway.db, a)).plaintext;
  keys.b = (await createApiKey(gateway.db, b)).plaintext;
  const viewer = await createUser(gateway.db, [{ projectId: a, role: 'viewer' }]);
  const login = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: viewer.email, password: viewer.password }),
  });
  cookieA = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await gateway.shutdown();
});

const upstreamCalls = () =>
  (gateway.registry.deployment('cached')?.provider as MockProvider).stats().requests;

async function chat(
  project: 'a' | 'b',
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${keys[project]}`,
      ...headers,
    },
    body: JSON.stringify({ model: 'mock-cached', ...body }),
  });
  return {
    status: res.status,
    cache: res.headers.get('x-gateway-cache'),
    id: res.headers.get('x-request-id')!,
    text: await res.text(),
  };
}

/** A prompt of its own per test, so tests never hit each other's entries. */
const prompt = () => ({
  messages: [{ role: 'user', content: `Say hello ${randomBytes(4).toString('hex')}` }],
});

describe('exact-match response cache', () => {
  it('never shares an entry between projects', async () => {
    const body = { ...prompt(), temperature: 0 };
    const calls = upstreamCalls();
    expect((await chat('a', body)).cache).toBe('miss');
    const hit = await chat('a', body);
    expect(hit.cache).toBe('hit');
    expect(upstreamCalls()).toBe(calls + 1);

    // The identical request from another project goes upstream and gets its own entry.
    expect((await chat('b', body)).cache).toBe('miss');
    expect(upstreamCalls()).toBe(calls + 2);
    expect((await chat('b', body)).cache).toBe('hit');
    expect(upstreamCalls()).toBe(calls + 2);
  });

  it('answers a hit like the original, streamed or not', async () => {
    const body = { ...prompt(), temperature: 0 };
    const first = JSON.parse((await chat('a', body)).text) as {
      choices: { message: { content: string } }[];
      usage: unknown;
    };
    const again = JSON.parse((await chat('a', body)).text) as typeof first;
    expect(again.choices[0]?.message.content).toBe(first.choices[0]?.message.content);
    expect(again.usage).toEqual(first.usage);

    const streamed = await chat('a', { ...body, stream: true });
    expect(streamed.cache).toBe('hit');
    const events = sseData(streamed.text);
    expect(events.at(-1)).toBe('[DONE]');
    const text = events
      .slice(0, -1)
      .map((e) => JSON.parse(e) as { choices: { delta: { content?: string } }[] })
      .map((c) => c.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe(first.choices[0]?.message.content);
  });

  it('stores a completed stream for later requests', async () => {
    const body = { ...prompt(), temperature: 0 };
    expect((await chat('a', { ...body, stream: true })).cache).toBe('miss');
    const calls = upstreamCalls();
    expect((await chat('a', body)).cache).toBe('hit');
    expect(upstreamCalls()).toBe(calls);
  });

  it('records a hit as a request with no attempts and zero cost', async () => {
    const body = { ...prompt(), temperature: 0 };
    await chat('a', body);
    const hit = await chat('a', body);
    let detail: Record<string, unknown> = {};
    await vi.waitFor(
      async () => {
        const res = await fetch(`${url}/admin/requests/${hit.id}`, {
          headers: { cookie: cookieA },
        });
        expect(res.status).toBe(200);
        detail = (await res.json()) as Record<string, unknown>;
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(detail).toMatchObject({
      status: 'success',
      cacheHit: true,
      deployment: null,
      attempts: [],
      usage: { source: 'reported', costMicroUsd: 0 },
    });
  });

  it('leaves sampled requests alone unless the caller opts in', async () => {
    const body = { ...prompt(), temperature: 0.7 };
    const calls = upstreamCalls();
    expect((await chat('a', body)).cache).toBeNull();
    expect((await chat('a', body)).cache).toBeNull();
    expect(upstreamCalls()).toBe(calls + 2);

    const on = { 'x-gateway-cache': 'on' };
    expect((await chat('a', body, on)).cache).toBe('miss');
    expect((await chat('a', body, on)).cache).toBe('hit');

    const deterministic = { ...prompt(), temperature: 0 };
    const off = { 'x-gateway-cache': 'off' };
    await chat('a', deterministic, off);
    expect((await chat('a', deterministic, off)).cache).toBeNull();
  });
});
