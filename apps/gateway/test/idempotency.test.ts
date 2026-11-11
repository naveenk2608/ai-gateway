import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { pruneIdempotencyKeys } from '@ai-gateway/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { guardrailPolicySchema, type GuardrailPolicyInput } from '../src/guardrails/policy.js';
import { requestFingerprint } from '../src/proxy/idempotency.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

// Idempotency-Key (M15, ADR 032) through the real gateway and worker, against Postgres and Redis.
const tag = randomBytes(3).toString('hex');
const models = parseModelsConfig(
  {
    deployments: {
      fast: { provider: 'mock', mock: { latencyMs: 20, completionTokens: 4 } },
      // Slow enough for a repeat to arrive while the first request is upstream.
      slow: { provider: 'mock', mock: { latencyMs: 1_500, completionTokens: 4 } },
      // A stream of 4 tokens over about 2 s, so a client can leave half way.
      trickle: { provider: 'mock', mock: { completionTokens: 4, tokensPerSecond: 2 } },
      // An answer larger than IDEMPOTENCY_MAX_BODY_BYTES below.
      wordy: { provider: 'mock', mock: { completionTokens: 2_000 } },
      broken: { provider: 'mock', mock: { failWith: 500 } },
      vectors: { provider: 'mock', type: 'embeddings', embedding: { dimensions: 8 } },
    },
    models: {
      'mock-fast': { deployment: 'fast' },
      'mock-slow': { deployment: 'slow' },
      'mock-trickle': { deployment: 'trickle' },
      'mock-wordy': { deployment: 'wordy' },
      'mock-broken': { deployment: 'broken' },
      'mock-vectors': { deployment: 'vectors' },
    },
  },
  'idempotency-test',
);

let gateway: Gateway;
let url: string;
const keys: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
const projects: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:idem:${tag}`,
      EVENTS_DLQ_STREAM: `test:idem:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `idem-${tag}`,
      WORKER_BLOCK_MS: '100',
      IDEMPOTENCY_MAX_BODY_BYTES: '4096',
      RETRY_MAX_ATTEMPTS: '1',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  projects.a = await createProject(gateway.db);
  projects.b = await createProject(gateway.db);
  keys.a = (await createApiKey(gateway.db, projects.a)).plaintext;
  keys.b = (await createApiKey(gateway.db, projects.b)).plaintext;
  // Project c turns on output masking half way through a test (M19).
  projects.c = await createProject(gateway.db);
  keys.c = (await createApiKey(gateway.db, projects.c)).plaintext;
});

afterAll(async () => {
  await gateway.shutdown();
});

const stats = (id: string) => (gateway.registry.deployment(id)?.provider as MockProvider).stats();

/** A new key per test, quoted as the draft's String. */
const newKey = () => `test-${randomBytes(8).toString('hex')}`;
const quoted = (key: string) => `"${key}"`;

/** A prompt of its own per test; temperature 0.7, so neither the cache nor coalescing applies. */
const chat = (model: string, stream = false) => ({
  model,
  messages: [{ role: 'user', content: `Say hello ${randomBytes(4).toString('hex')}` }],
  temperature: 0.7,
  stream,
});

function send(
  payload: Record<string, unknown>,
  {
    key,
    project = 'a',
    signal,
    path = '/v1/chat/completions',
  }: { key?: string; project?: 'a' | 'b' | 'c'; signal?: AbortSignal; path?: string } = {},
) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${keys[project]}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
}

async function reply(res: Promise<Response>) {
  const r = await res;
  return {
    status: r.status,
    replayed: r.headers.get('idempotent-replayed'),
    retryAfter: r.headers.get('retry-after'),
    deployment: r.headers.get('x-gateway-deployment'),
    id: r.headers.get('x-request-id')!,
    text: await r.text(),
  };
}

type Row = { id: string; replayed: boolean; status: string; attempt_count: number };

/** Waits until the worker has stored every one of the requests. */
async function records(ids: string[]): Promise<Map<string, Row>> {
  let rows: Row[] = [];
  await vi.waitFor(
    async () => {
      rows = await gateway.db
        .selectFrom('request_records')
        .select(['id', 'replayed', 'status', 'attempt_count'])
        .where('id', 'in', ids)
        .execute();
      expect(rows).toHaveLength(ids.length);
    },
    { timeout: 15_000, interval: 200 },
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const keyRow = (project: string, key: string, endpoint = 'chat') =>
  gateway.db
    .selectFrom('idempotency_keys')
    .selectAll()
    .where('project_id', '=', project)
    .where('endpoint', '=', endpoint as 'chat')
    .where('idempotency_key', '=', key)
    .executeTakeFirst();

/** Resolves once the deployment has `n` calls in progress. */
const upstreamActive = (id: string, n = 1) =>
  vi.waitFor(() => expect(stats(id).active).toBe(n), { timeout: 5_000, interval: 10 });

describe('Idempotency-Key', () => {
  it('answers a repeat with the first answer: one upstream call and one charge', async () => {
    const before = stats('fast').requests;
    const key = newKey();
    const payload = chat('mock-fast');
    const first = await reply(send(payload, { key: quoted(key) }));
    const again = await reply(send(payload, { key: quoted(key) }));
    // A repeat that asks for a stream gets the same answer as a stream.
    const streamed = await reply(send({ ...payload, stream: true }, { key: quoted(key) }));
    expect([first.status, again.status, streamed.status]).toEqual([200, 200, 200]);
    expect(stats('fast').requests - before).toBe(1);
    expect(first.replayed).toBeNull();
    expect(again.replayed).toBe('true');
    expect(again.text).toBe(first.text);
    expect(again.deployment).toBe('fast');
    const content = (JSON.parse(first.text) as { choices: { message: { content: string } }[] })
      .choices[0]!.message.content;
    const deltas = sseData(streamed.text)
      .filter((d) => d !== '[DONE]')
      .map((d) => JSON.parse(d) as { choices: { delta: { content?: string } }[] })
      .map((c) => c.choices[0]?.delta.content ?? '')
      .join('');
    expect(deltas).toBe(content);

    const stored = await records([first.id, again.id, streamed.id]);
    expect(stored.get(first.id)).toMatchObject({ replayed: false, attempt_count: 1 });
    expect(stored.get(again.id)).toMatchObject({ replayed: true, attempt_count: 0 });
    expect(stored.get(streamed.id)).toMatchObject({ replayed: true, attempt_count: 0 });
    const usage = await gateway.db
      .selectFrom('usage_events')
      .select(['request_id', 'deployment', 'cost_micro_usd'])
      .where('request_id', 'in', [again.id, streamed.id])
      .execute();
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.deployment === null && Number(u.cost_micro_usd) === 0)).toBe(true);
  });

  it('refuses the key with a different body (422), and a malformed key (400)', async () => {
    const key = newKey();
    expect((await reply(send(chat('mock-fast'), { key: quoted(key) }))).status).toBe(200);
    const other = await reply(send(chat('mock-fast'), { key: quoted(key) }));
    expect(other.status).toBe(422);
    expect(JSON.parse(other.text)).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    const bare = await reply(send(chat('mock-fast'), { key: 'not-quoted' }));
    expect(bare.status).toBe(400);
    expect(JSON.parse(bare.text)).toMatchObject({ error: { code: 'invalid_idempotency_key' } });
  });

  it('makes a repeat that arrives while the first runs wait for it on this instance', async () => {
    const before = stats('slow').requests;
    const key = newKey();
    const payload = chat('mock-slow');
    const first = reply(send(payload, { key: quoted(key) }));
    await upstreamActive('slow');
    const second = reply(send(payload, { key: quoted(key) }));
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stats('slow').requests - before).toBe(1);
    expect(b.replayed).toBe('true');
    expect(b.text).toBe(a.text);
  });

  it('answers 409 with retry-after while another instance runs the first request', async () => {
    const key = newKey();
    const payload = chat('mock-fast');
    await gateway.db
      .insertInto('idempotency_keys')
      .values({
        id: uuidv7(),
        project_id: projects.a,
        endpoint: 'chat',
        idempotency_key: key,
        fingerprint: requestFingerprint(payload),
        status: 'in_progress',
        request_id: uuidv7(),
        owner: 'another-instance',
        locked_until: new Date(Date.now() + 60_000),
        expires_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const busy = await reply(send(payload, { key: quoted(key) }));
    expect(busy.status).toBe(409);
    expect(Number(busy.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(busy.text)).toMatchObject({
      error: { code: 'idempotency_key_in_progress' },
    });
  });

  it('finishes and stores the call when the client leaves mid-stream; the retry gets it', async () => {
    const before = stats('trickle');
    const key = newKey();
    const payload = chat('mock-trickle', true);
    const gone = new AbortController();
    const res = await send(payload, { key: quoted(key), signal: gone.signal });
    const firstId = res.headers.get('x-request-id')!;
    await res.body!.getReader().read();
    gone.abort();
    await vi.waitFor(
      async () => expect((await keyRow(projects.a, key))?.status).toBe('completed'),
      {
        timeout: 10_000,
        interval: 100,
      },
    );
    const after = stats('trickle');
    expect(after.requests - before.requests).toBe(1);
    // The upstream stream ran to its end.
    expect(after.canceled - before.canceled).toBe(0);
    const retry = await reply(send({ ...payload, stream: false }, { key: quoted(key) }));
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe('true');
    expect(stats('trickle').requests - before.requests).toBe(1);
    const stored = await records([firstId, retry.id]);
    // Recorded as cancelled with the attempt (and its cost); the retry costs nothing.
    expect(stored.get(firstId)).toMatchObject({ status: 'canceled', attempt_count: 1 });
    expect(stored.get(retry.id)).toMatchObject({ replayed: true, attempt_count: 0 });
  });

  it('releases the key when the request fails, so a retry runs again', async () => {
    const before = stats('broken').requests;
    const key = newKey();
    const payload = chat('mock-broken');
    const failed = await reply(send(payload, { key: quoted(key) }));
    expect(failed.status).toBe(502);
    expect(await keyRow(projects.a, key)).toBeUndefined();
    const retry = await reply(send(payload, { key: quoted(key) }));
    expect(retry.status).toBe(502);
    expect(retry.replayed).toBeNull();
    expect(stats('broken').requests - before).toBe(2);
  });

  it('runs a request again once its key has expired, and the worker deletes expired keys', async () => {
    const before = stats('fast').requests;
    const key = newKey();
    const payload = chat('mock-fast');
    expect((await reply(send(payload, { key: quoted(key) }))).status).toBe(200);
    await gateway.db
      .updateTable('idempotency_keys')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('project_id', '=', projects.a)
      .where('idempotency_key', '=', key)
      .execute();
    const again = await reply(send(payload, { key: quoted(key) }));
    expect(again.status).toBe(200);
    expect(again.replayed).toBeNull();
    expect(stats('fast').requests - before).toBe(2);

    const old = newKey();
    expect((await reply(send(chat('mock-fast'), { key: quoted(old) }))).status).toBe(200);
    await gateway.db
      .updateTable('idempotency_keys')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('idempotency_key', '=', old)
      .execute();
    expect(await pruneIdempotencyKeys(gateway.db, Date.now(), 1)).toBeGreaterThanOrEqual(1);
    expect(await keyRow(projects.a, old)).toBeUndefined();
    // The key that is still valid is kept.
    expect(await keyRow(projects.a, key)).toBeDefined();
  });

  it('keeps two projects with the same key apart', async () => {
    const before = stats('fast').requests;
    const key = newKey();
    const payload = chat('mock-fast');
    const a = await reply(send(payload, { key: quoted(key), project: 'a' }));
    const b = await reply(send(payload, { key: quoted(key), project: 'b' }));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.replayed, b.replayed]).toEqual([null, null]);
    expect(stats('fast').requests - before).toBe(2);
  });

  it('answers 409 for a repeat whose first answer was too large to keep, without a second call', async () => {
    const before = stats('wordy').requests;
    const key = newKey();
    const payload = chat('mock-wordy');
    expect((await reply(send(payload, { key: quoted(key) }))).status).toBe(200);
    const row = await keyRow(projects.a, key);
    expect(row).toMatchObject({ status: 'completed', response: null });
    const again = await reply(send(payload, { key: quoted(key) }));
    expect(again.status).toBe(409);
    expect(JSON.parse(again.text)).toMatchObject({
      error: { code: 'idempotency_answer_not_stored' },
    });
    expect(stats('wordy').requests - before).toBe(1);
  });

  it('replays embeddings too, keyed apart from chat', async () => {
    const before = stats('vectors').requests;
    const key = newKey();
    const payload = { model: 'mock-vectors', input: [`a ${key}`, `b ${key}`] };
    const options = { key: quoted(key), path: '/v1/embeddings' };
    const first = await reply(send(payload, options));
    const again = await reply(send(payload, options));
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.replayed).toBe('true');
    expect(again.text).toBe(first.text);
    expect(stats('vectors').requests - before).toBe(1);
    // The same key on chat is another key.
    const onChat = await reply(send(chat('mock-fast'), { key: quoted(key) }));
    expect(onChat.status).toBe(200);
    expect(onChat.replayed).toBeNull();
  });
});

describe('Idempotency-Key and output guardrails (M19)', () => {
  const EMAIL = 'jane.doe@example.com';

  /** Saves the project's guardrails as the admin API does, and drops its cached keys. */
  async function setGuardrails(projectId: string, policy: GuardrailPolicyInput) {
    await gateway.db
      .updateTable('projects')
      .set({ guardrails: JSON.stringify(guardrailPolicySchema.parse(policy)) })
      .where('id', '=', projectId)
      .execute();
    gateway.verifier.invalidateProject(projectId);
  }

  it("replays the first answer as the project's output guardrails allow it now", async () => {
    const spy = vi
      .spyOn(gateway.registry.deployment('fast')!.provider, 'chat')
      .mockResolvedValueOnce({
        content: `Write to ${EMAIL}`,
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 4, totalTokens: 9 },
      });
    try {
      const raw = newKey();
      const key = quoted(raw);
      const body = chat('mock-fast');
      // Stored while the project had no output checks.
      const first = await reply(send(body, { key, project: 'c' }));
      expect(first.status).toBe(200);
      expect(first.text).toContain(EMAIL);
      expect(JSON.stringify((await keyRow(projects.c, raw))?.response)).toContain(EMAIL);

      await setGuardrails(projects.c, { output: { email: 'mask' } });
      const again = await reply(send(body, { key, project: 'c' }));
      expect(again).toMatchObject({ status: 200, replayed: 'true' });
      expect(again.text).not.toContain(EMAIL);
      expect(
        (JSON.parse(again.text) as { choices: { message: { content: string } }[] }).choices[0]!
          .message.content,
      ).toBe('Write to [EMAIL]');

      const streamed = await reply(send({ ...body, stream: true }, { key, project: 'c' }));
      expect(streamed).toMatchObject({ status: 200, replayed: 'true' });
      expect(streamed.text).not.toContain(EMAIL);
      const text = sseData(streamed.text)
        .filter((d) => d !== '[DONE]')
        .map(
          (d) =>
            (JSON.parse(d) as { choices: { delta: { content?: string } }[] }).choices[0]?.delta
              .content ?? '',
        )
        .join('');
      expect(text).toBe('Write to [EMAIL]');
      expect(spy).toHaveBeenCalledTimes(1);

      // Each replay records its finding, as a fresh answer would.
      await vi.waitFor(
        async () => {
          const rows = await gateway.db
            .selectFrom('guardrail_results')
            .select(['request_id', 'stage', 'check', 'action', 'findings'])
            .where('request_id', 'in', [again.id, streamed.id])
            .execute();
          const finding = { stage: 'output', check: 'email', action: 'mask', findings: 1 };
          expect(rows.map((r) => r.request_id).sort()).toEqual([again.id, streamed.id].sort());
          for (const row of rows) expect(row).toMatchObject(finding);
        },
        { timeout: 15_000, interval: 200 },
      );
    } finally {
      spy.mockRestore();
      await setGuardrails(projects.c, {});
    }
  });
});
