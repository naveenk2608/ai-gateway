import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ManualClock, uuidv7 } from '@ai-gateway/shared';
import { pruneSemanticCache } from '@ai-gateway/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { guardrailPolicySchema } from '../src/guardrails/policy.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { chatCompletionRequestSchema } from '../src/proxy/schema.js';
import { parseSemanticPolicy, type SemanticPolicy } from '../src/semantic/policy.js';
import { SemanticCache, type Embedder } from '../src/semantic/semantic-cache.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { sendJson, startFakeUpstream, type FakeUpstream } from './fake-upstream.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

/**
 * The semantic cache against Postgres with pgvector (ADR 040). The embeddings deployment is a
 * fake upstream whose vectors this file chooses, so every similarity below is known: each vector
 * is a unit vector, and its similarity to Q is its first number.
 */
const Q = 'What is the capital of France?';
/** Its embedding call is slow, so identical requests arrive while the first is still embedding. */
const BURST = 'Which river runs through Paris?';
const VECTORS: Record<string, number[]> = {
  [Q]: [1, 0, 0],
  'Tell me the capital city of France.': [0.96, 0.28, 0],
  'Which city is the capital of France?': [0.85, Math.sqrt(1 - 0.85 ** 2), 0],
  'Name a large ocean.': [0, 0, 1],
  [BURST]: [0, 1, 0],
};
const PARAPHRASE = 'Tell me the capital city of France.';
const LOOSER = 'Which city is the capital of France?';

const tag = randomBytes(3).toString('hex');
// Model names of this file only, so its prices never apply to another file's requests.
const ANSWER_MODEL = `sem-answer-${tag}`;
const VEC_MODEL = `vec-model-${tag}`;
let upstream: FakeUpstream;
let gateway: Gateway;
let url: string;

beforeAll(async () => {
  upstream = await startFakeUpstream(async (req, res) => {
    const { input } = JSON.parse(req.body) as { input: string[] };
    if (input[0] === BURST) await new Promise((resolve) => setTimeout(resolve, 300));
    const vector = VECTORS[input[0] ?? ''];
    if (!vector) {
      sendJson(res, 500, { error: { message: 'no vector for this text' } });
      return;
    }
    sendJson(res, 200, {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: vector }],
      model: VEC_MODEL,
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
  });
  const models = parseModelsConfig(
    {
      deployments: {
        answer: { provider: 'mock', model: ANSWER_MODEL, mock: { completionTokens: 5 } },
        'answer-2': { provider: 'mock', mock: { completionTokens: 5 } },
        vec: {
          provider: 'openai-compatible',
          type: 'embeddings',
          model: VEC_MODEL,
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
      RUN_WORKER_IN_PROCESS: 'true',
      WORKER_BLOCK_MS: '100',
      EVENTS_STREAM: `test:semantic:${tag}`,
      EVENTS_DLQ_STREAM: `test:semantic:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `semantic-${tag}`,
    }),
    captureLogger().logger,
    { models, env: { TEST_UPSTREAM_KEY: 'test-key-not-secret' } },
  );
  await gateway.start();
  // $1 per million input tokens for the embedding model; $2 and $4 for the chat model.
  await gateway.db
    .insertInto('model_prices')
    .values([
      {
        id: uuidv7(),
        provider: 'openai-compatible',
        model: VEC_MODEL,
        input_micro_usd_per_mtok: 1_000_000,
        output_micro_usd_per_mtok: 0,
        effective_from: new Date(0),
      },
      {
        id: uuidv7(),
        provider: 'mock',
        model: ANSWER_MODEL,
        input_micro_usd_per_mtok: 2_000_000,
        output_micro_usd_per_mtok: 4_000_000,
        effective_from: new Date(0),
      },
    ])
    .execute();
  await gateway.prices.refresh();
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
    requestId: res.headers.get('x-request-id'),
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

  it('identical requests in flight make one embedding call and one upstream call', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const embedsBefore = embedCalls();
    const before = calls('answer');
    const answers = await Promise.all(Array.from({ length: 5 }, () => chat(a.key, BURST)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // The first leads (a lookup, then the call); the others wait for its answer (ADR 031).
    expect(answers.filter((r) => r.cache === 'coalesced')).toHaveLength(4);
    expect(embedCalls() - embedsBefore).toBe(1);
    expect(calls('answer') - before).toBe(1);
    expect(await entries(a.id, 1)).toBe(1);
  });

  it('a streamed miss is stored too, and answers a later paraphrase', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const streamed = await chat(a.key, Q, { stream: true });
    expect(streamed.cache).toBeNull();
    await entries(a.id, 1);
    expect((await chat(a.key, PARAPHRASE)).cache).toBe('semantic');
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

/** The request's record once the worker has stored it. */
async function record(requestId: string) {
  for (let i = 0; i < 200; i++) {
    const row = await gateway.db
      .selectFrom('request_records')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`request ${requestId} was not stored`);
}

describe('semantic cache accounting', () => {
  it('records hits like cache hits with their similarity, and every embedding call as spend', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const miss = await chat(a.key, Q);
    await entries(a.id, 1);
    const hit = await chat(a.key, PARAPHRASE);
    const failed = await chat(a.key, 'Another text the embedding upstream refuses.');
    expect(hit.cache).toBe('semantic');

    const missRow = await record(miss.requestId!);
    expect(missRow).toMatchObject({
      cache_hit: false,
      semantic_cache: 'miss',
      semantic_similarity: null,
      embedding_deployment: 'vec',
      embedding_tokens: 7,
      // 7 tokens at $1 per million: 7 micro-dollars, list and billed (a paid deployment).
      embedding_cost_micro_usd: 7,
      embedding_billed_cost_micro_usd: 7,
      semantic_avoided_cost_micro_usd: null,
    });

    const hitRow = await record(hit.requestId!);
    expect(hitRow).toMatchObject({
      cache_hit: true,
      attempt_count: 0,
      semantic_cache: 'hit',
      embedding_tokens: 7,
      embedding_cost_micro_usd: 7,
    });
    expect(hitRow.semantic_similarity).toBeCloseTo(0.96, 5);
    // The hit's usage row costs nothing, like any cache hit; what the stored answer cost at the
    // chat model's price is the cost it avoided.
    const usage = await gateway.db
      .selectFrom('usage_events')
      .selectAll()
      .where('request_id', 'in', [miss.requestId!, hit.requestId!])
      .execute();
    const missUsage = usage.find((u) => u.request_id === miss.requestId)!;
    const hitUsage = usage.find((u) => u.request_id === hit.requestId)!;
    expect(hitUsage).toMatchObject({
      cost_micro_usd: 0,
      prompt_tokens: missUsage.prompt_tokens,
      completion_tokens: missUsage.completion_tokens,
    });
    expect(Number(hitRow.semantic_avoided_cost_micro_usd)).toBe(Number(missUsage.cost_micro_usd));
    expect(Number(missUsage.cost_micro_usd)).toBeGreaterThan(0);

    // A failed embedding call is recorded as an error and costs nothing.
    expect(await record(failed.requestId!)).toMatchObject({
      semantic_cache: 'error',
      embedding_deployment: null,
      embedding_cost_micro_usd: null,
    });

    // The project's spend counts both calls, the embedding calls included.
    const spent = await gateway.db
      .selectFrom('budget_periods')
      .select((eb) => eb.fn.sum<string>('spent_micro_usd').as('spent'))
      .where('project_id', '=', a.id)
      .executeTakeFirstOrThrow();
    const failedUsage = await gateway.db
      .selectFrom('usage_events')
      .select('cost_micro_usd')
      .where('request_id', '=', failed.requestId!)
      .executeTakeFirstOrThrow();
    expect(Number(spent.spent)).toBe(
      Number(missUsage.cost_micro_usd) + Number(failedUsage.cost_micro_usd) + 7 + 7,
    );

    // The admin summary shows the embedding cost of hits and misses against the cost avoided.
    const viewer = await createUser(gateway.db, [{ projectId: a.id, role: 'viewer' }]);
    const login = await fetch(`${url}/admin/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: viewer.email, password: viewer.password }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const summary = await fetch(`${url}/admin/projects/${a.id}/semantic-cache/summary`, {
      headers: { cookie },
    });
    expect(summary.status).toBe(200);
    const avoided = Number(missUsage.cost_micro_usd);
    expect(await summary.json()).toEqual({
      range: '24h',
      lookups: { hit: 1, miss: 1, error: 1 },
      hitSimilarity: expect.closeTo(0.96, 5) as number,
      embedding: { listMicroUsd: 14, billedMicroUsd: 14, tokens: 14, unpriced: 0 },
      avoided: { listMicroUsd: avoided, billedMicroUsd: avoided, unpriced: 0 },
      net: { listMicroUsd: avoided - 14, billedMicroUsd: avoided - 14 },
    });
    const settings = await fetch(`${url}/admin/projects/${a.id}/semantic-cache`, {
      headers: { cookie },
    });
    expect(await settings.json()).toMatchObject({
      enabled: true,
      available: true,
      embeddingModel: 'sem-embed',
      policy: { mode: 'all', threshold: 0.9 },
    });
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

describe('semantic hits and output guardrails (M19)', () => {
  const EMAIL = 'jane.doe@example.com';

  it('masks a hit stored before output masking was on, plain and streamed, and records it', async () => {
    const a = await project({ mode: 'all', threshold: 0.9 });
    const spy = vi
      .spyOn(gateway.registry.deployment('answer')!.provider, 'chat')
      .mockResolvedValueOnce({
        content: `Write to ${EMAIL}`,
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 },
      });
    try {
      // Stored while the project had no output checks.
      const first = await chat(a.key, Q);
      expect(contentOf(first.body)).toBe(`Write to ${EMAIL}`);
      await entries(a.id, 1);

      // Output masking turned on, as the admin API saves it.
      await gateway.db
        .updateTable('projects')
        .set({
          guardrails: JSON.stringify(guardrailPolicySchema.parse({ output: { email: 'mask' } })),
        })
        .where('id', '=', a.id)
        .execute();
      gateway.verifier.invalidateProject(a.id);

      const hit = await chat(a.key, PARAPHRASE);
      expect(hit.cache).toBe('semantic');
      expect(contentOf(hit.body)).toBe('Write to [EMAIL]');
      const streamed = await chat(a.key, PARAPHRASE, { stream: true });
      expect(streamed.cache).toBe('semantic');
      expect(streamed.body as string).not.toContain(EMAIL);
      const text = sseData(streamed.body as string)
        .filter((d) => d !== '[DONE]')
        .map((d) => (JSON.parse(d) as { choices: { delta: { content?: string } }[] }).choices[0])
        .map((c) => c?.delta.content ?? '')
        .join('');
      expect(text).toBe('Write to [EMAIL]');
      expect(spy).toHaveBeenCalledTimes(1);

      // Each hit records its finding, as a fresh answer would.
      const ids = [hit.requestId!, streamed.requestId!];
      await vi.waitFor(
        async () => {
          const rows = await gateway.db
            .selectFrom('guardrail_results')
            .select(['request_id', 'stage', 'check', 'action', 'findings'])
            .where('request_id', 'in', ids)
            .execute();
          expect(rows.map((r) => r.request_id).sort()).toEqual([...ids].sort());
          for (const row of rows) {
            expect(row).toMatchObject({
              stage: 'output',
              check: 'email',
              action: 'mask',
              findings: 1,
            });
          }
        },
        { timeout: 15_000, interval: 200 },
      );
    } finally {
      spy.mockRestore();
    }
  });
});
