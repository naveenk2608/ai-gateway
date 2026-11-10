import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ManualClock } from '@ai-gateway/shared';
import { pruneSemanticCache } from '@ai-gateway/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { chatCompletionRequestSchema } from '../src/proxy/schema.js';
import { parseSemanticPolicy, type SemanticPolicy } from '../src/semantic/policy.js';
import { SemanticCache, type Embedder } from '../src/semantic/semantic-cache.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { sendJson, startFakeUpstream, type FakeUpstream } from './fake-upstream.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

/**
 * The semantic cache against Postgres with pgvector (ADR 040). The embeddings deployment is a
 * fake upstream whose vectors this file chooses, so every similarity below is known: each vector
 * is a unit vector, and its similarity to Q is its first number.
 */
const Q = 'What is the capital of France?';
const VECTORS: Record<string, number[]> = {
  [Q]: [1, 0, 0],
  'Tell me the capital city of France.': [0.96, 0.28, 0],
  'Which city is the capital of France?': [0.85, Math.sqrt(1 - 0.85 ** 2), 0],
  'Name a large ocean.': [0, 0, 1],
};
const PARAPHRASE = 'Tell me the capital city of France.';
const LOOSER = 'Which city is the capital of France?';

const tag = randomBytes(3).toString('hex');
let upstream: FakeUpstream;
let gateway: Gateway;
let url: string;

beforeAll(async () => {
  upstream = await startFakeUpstream((req, res) => {
    const { input } = JSON.parse(req.body) as { input: string[] };
    const vector = VECTORS[input[0] ?? ''];
    if (!vector) {
      sendJson(res, 500, { error: { message: 'no vector for this text' } });
      return;
    }
    sendJson(res, 200, {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: vector }],
      model: 'vec-model',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
  });
  const models = parseModelsConfig(
    {
      deployments: {
        answer: { provider: 'mock', mock: { completionTokens: 5 } },
        'answer-2': { provider: 'mock', mock: { completionTokens: 5 } },
        vec: {
          provider: 'openai-compatible',
          type: 'embeddings',
          model: 'vec-model',
          baseUrl: `${upstream.url}/v1`,
          apiKeyEnv: 'TEST_UPSTREAM_KEY',
          embedding: { dimensions: 3 },
        },
      },
      models: {
        'sem-chat': { deployment: 'answer' },
        'sem-chat-2': { deployment: 'answer-2' },
        'sem-embed': { deployment: 'vec' },
      },
    },
    'semantic-test',
  );
  gateway = createGateway(
    testConfig({
      SEMANTIC_CACHE_ENABLED: 'true',
      SEMANTIC_CACHE_EMBEDDING_MODEL: 'sem-embed',
      EVENTS_STREAM: `test:semantic:${tag}`,
      EVENTS_DLQ_STREAM: `test:semantic:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `semantic-${tag}`,
    }),
    captureLogger().logger,
    { models, env: { TEST_UPSTREAM_KEY: 'test-key-not-secret' } },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway.shutdown();
  await upstream.close();
});

/** A project with these semantic cache settings, and an API key for it. */
async function project(settings: Partial<SemanticPolicy>) {
  const id = await createProject(gateway.db);
  await gateway.db
    .updateTable('projects')
    .set({ semantic_cache: JSON.stringify(settings) })
    .where('id', '=', id)
    .execute();
  return { id, key: (await createApiKey(gateway.db, id)).plaintext };
}

const calls = (deployment: 'answer' | 'answer-2') =>
  (gateway.registry.deployment(deployment)?.provider as MockProvider).stats().requests;
const embedCalls = () => upstream.requests.length;

async function chat(
  key: string,
  text: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'sem-chat',
      temperature: 0,
      messages: [{ role: 'user', content: text }],
      ...extra,
    }),
  });
  const isStream = res.headers.get('content-type')?.startsWith('text/event-stream') === true;
  return {
    status: res.status,
    cache: res.headers.get('x-gateway-cache'),
    similarity: res.headers.get('x-gateway-semantic-similarity'),
    body: isStream ? await res.text() : ((await res.json()) as Record<string, unknown>),
  };
}

const contentOf = (body: unknown) =>
  (body as { choices: { message: { content: string } }[] }).choices[0]!.message.content;

/** Waits until the project has this many stored entries (stores run after the reply). */
async function entries(projectId: string, atLeast: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const row = await gateway.db
      .selectFrom('semantic_cache_entries')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('project_id', '=', projectId)
      .executeTakeFirstOrThrow();
    if (Number(row.n) >= atLeast) return Number(row.n);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${atLeast} entries`);
}

describe('semantic cache through the gateway', () => {
  it('migration 0018 created the table, so the cache is available', async () => {
    const { rows } = await sql<{ ok: boolean }>`
      SELECT to_regclass('semantic_cache_entries') IS NOT NULL AS ok`.execute(gateway.db);
    expect(rows[0]?.ok).toBe(true);
  });

  it('answers a paraphrase above the threshold from the stored answer, plain and streamed', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const before = calls('answer');
    const first = await chat(a.key, Q);
    expect(first).toMatchObject({ status: 200, cache: null });
    await entries(a.id, 1);

    const second = await chat(a.key, PARAPHRASE);
    expect(second).toMatchObject({ status: 200, cache: 'semantic', similarity: '0.9600' });
    expect(contentOf(second.body)).toBe(contentOf(first.body));

    const streamed = await chat(a.key, PARAPHRASE, { stream: true });
    expect(streamed.cache).toBe('semantic');
    const text = sseData(streamed.body as string)
      .filter((d) => d !== '[DONE]')
      .map((d) => (JSON.parse(d) as { choices: { delta: { content?: string } }[] }).choices[0])
      .map((c) => c?.delta.content ?? '')
      .join('');
    expect(text).toBe(contentOf(first.body));
    // One upstream call for the three requests.
    expect(calls('answer') - before).toBe(1);
  });

  it('respects the threshold: 0.85 misses at 0.9 and hits at 0.8', async () => {
    const strict = await project({ mode: 'all', threshold: 0.9 });
    const loose = await project({ mode: 'all', threshold: 0.8 });
    for (const p of [strict, loose]) {
      await chat(p.key, Q);
      await entries(p.id, 1);
    }
    const before = calls('answer');
    expect((await chat(strict.key, LOOSER)).cache).toBeNull();
    expect(calls('answer') - before).toBe(1);
    expect(await chat(loose.key, LOOSER)).toMatchObject({
      cache: 'semantic',
      similarity: '0.8500',
    });
    expect(calls('answer') - before).toBe(1);
  });

  it('never crosses projects, models or parameters', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const b = await project({ mode: 'all', threshold: 0.9 });
    await chat(a.key, Q);
    await entries(a.id, 1);

    // Another project, even with the identical text.
    expect((await chat(b.key, Q)).cache).toBeNull();
    // Another logical model of the same project.
    const before2 = calls('answer-2');
    expect((await chat(a.key, PARAPHRASE, { model: 'sem-chat-2' })).cache).toBeNull();
    expect(calls('answer-2') - before2).toBe(1);
    // Another output cap, seed, system prompt or earlier turn.
    expect((await chat(a.key, PARAPHRASE, { max_tokens: 9 })).cache).toBeNull();
    expect((await chat(a.key, PARAPHRASE, { seed: 3 })).cache).toBeNull();
    const withSystem = {
      messages: [
        { role: 'system', content: 'Answer in French.' },
        { role: 'user', content: PARAPHRASE },
      ],
    };
    expect((await chat(a.key, PARAPHRASE, withSystem)).cache).toBeNull();
    // The same request without those changes still hits.
    expect((await chat(a.key, PARAPHRASE)).cache).toBe('semantic');
  });

  it("follows each project's mode and the request's header", async () => {
    const off = await project({});
    const header = await project({ mode: 'header', threshold: 0.9 });
    const all = await project({ mode: 'all', threshold: 0.9 });
    let before = embedCalls();
    await chat(off.key, Q, {}, { 'x-gateway-semantic-cache': 'on' });
    await chat(header.key, Q);
    await chat(all.key, Q, {}, { 'x-gateway-semantic-cache': 'off' });
    expect(embedCalls() - before).toBe(0);

    before = embedCalls();
    await chat(header.key, Q, {}, { 'x-gateway-semantic-cache': 'on' });
    await entries(header.id, 1);
    expect(embedCalls() - before).toBe(1);
    expect(
      (await chat(header.key, PARAPHRASE, {}, { 'x-gateway-semantic-cache': 'on' })).cache,
    ).toBe('semantic');
    // Sampled requests are not ones the exact cache would take, so they make no lookup either.
    before = embedCalls();
    await chat(all.key, Q, { temperature: 0.7 });
    expect(embedCalls() - before).toBe(0);
  });

  it('an embedding failure falls back to a normal request', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const before = calls('answer');
    const embedsBefore = embedCalls();
    const res = await chat(a.key, 'A text the embedding upstream refuses.');
    expect(res).toMatchObject({ status: 200, cache: null });
    expect(contentOf(res.body)).toEqual(expect.any(String));
    expect(calls('answer') - before).toBe(1);
    // One try only: a lookup is an optimisation.
    expect(embedCalls() - embedsBefore).toBe(1);
  });
});

describe('semantic cache storage: TTL and the row cap', () => {
  const body = (text: string) =>
    chatCompletionRequestSchema.parse({
      model: 'sem-chat',
      temperature: 0,
      messages: [{ role: 'user', content: text }],
    });
  const answer = {
    content: 'Paris',
    finishReason: 'stop' as const,
    usage: { promptTokens: 8, completionTokens: 1, totalTokens: 9 },
  };
  const embedding = {
    deployment: 'vec',
    provider: 'openai-compatible',
    providerModel: 'vec-model',
    billing: 'paid' as const,
    promptTokens: 7,
    usageSource: 'reported' as const,
  };
  const embed: Embedder = (text) =>
    Promise.resolve({ vector: VECTORS[text] ?? [0, 1, 0], record: embedding });

  function cacheAt(clock: ManualClock) {
    return new SemanticCache({
      db: gateway.db,
      logger: captureLogger().logger,
      clock,
      embeddingModel: 'sem-embed',
      embed,
    });
  }
  const callFor = (projectId: string) => ({
    requestId: 'r',
    projectId,
    apiKeyId: null,
    clientSignal: new AbortController().signal,
    log: captureLogger().logger,
  });

  it('a stored answer is found until its TTL and gone after; the worker deletes it', async () => {
    const id = await createProject(gateway.db);
    const policy = parseSemanticPolicy({ mode: 'all', threshold: 0.9, ttlSeconds: 60 });
    // Near the real time: other files' workers prune by the wall clock.
    const clock = new ManualClock(Date.now());
    const cache = cacheAt(clock);
    const miss = await cache.lookup({ body: body(Q), policy, call: callFor(id) });
    expect(miss?.record.outcome).toBe('miss');
    await miss?.store?.(answer, null);

    await clock.advance(59_000);
    expect(
      (await cache.lookup({ body: body(PARAPHRASE), policy, call: callFor(id) }))?.hit,
    ).toEqual(answer);
    await clock.advance(2_000);
    const expired = await cache.lookup({ body: body(PARAPHRASE), policy, call: callFor(id) });
    expect(expired?.record).toMatchObject({ outcome: 'miss', similarity: null });

    expect(await pruneSemanticCache(gateway.db, clock.now())).toBeGreaterThanOrEqual(1);
    const left = await gateway.db
      .selectFrom('semantic_cache_entries')
      .select('id')
      .where('project_id', '=', id)
      .execute();
    expect(left).toEqual([]);
  });

  it("keeps at most the project's cap, dropping the oldest", async () => {
    const id = await createProject(gateway.db);
    const other = await createProject(gateway.db);
    const policy = parseSemanticPolicy({ mode: 'all', maxEntries: 3 });
    const clock = new ManualClock(Date.now());
    const cache = cacheAt(clock);
    await (
      await cache.lookup({ body: body(Q), policy, call: callFor(other) })
    )?.store?.(answer, null);
    const texts = Object.keys(VECTORS);
    for (let i = 0; i < 5; i++) {
      await clock.advance(1_000);
      const found = await cache.lookup({
        body: body(texts[i % texts.length]!),
        policy: { ...policy, threshold: 1 },
        call: callFor(id),
      });
      await found?.store?.({ ...answer, content: `answer ${i}` }, null);
    }
    const kept = await gateway.db
      .selectFrom('semantic_cache_entries')
      .select('answer')
      .where('project_id', '=', id)
      .orderBy('created_at')
      .execute();
    expect(kept.map((r) => (r.answer as { content: string }).content)).toEqual([
      'answer 2',
      'answer 3',
      'answer 4',
    ]);
    // Another project's rows are not touched by this project's cap.
    expect(await entries(other, 1)).toBe(1);
  });
});
