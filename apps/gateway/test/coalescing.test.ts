import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

// Request coalescing (ADR 031) through the real gateway and worker: one upstream call for
// identical requests in flight, one request record each, followers marked `coalesced`.
const tag = randomBytes(3).toString('hex');
const models = parseModelsConfig(
  {
    deployments: {
      // Slow enough for every follower to arrive while the leader is upstream.
      slow: { provider: 'mock', mock: { latencyMs: 1_500, completionTokens: 4 } },
      // A stream of 4 tokens over about 2 s, so a leader can leave half way.
      trickle: { provider: 'mock', mock: { completionTokens: 4, tokensPerSecond: 2 } },
    },
    models: { 'mock-slow': { deployment: 'slow' }, 'mock-trickle': { deployment: 'trickle' } },
  },
  'coalescing-test',
);

let gateway: Gateway;
let url: string;
const keys: Record<'a' | 'b', string> = { a: '', b: '' };

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:coalesce:${tag}`,
      EVENTS_DLQ_STREAM: `test:coalesce:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `coalesce-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  keys.a = (await createApiKey(gateway.db, await createProject(gateway.db))).plaintext;
  keys.b = (await createApiKey(gateway.db, await createProject(gateway.db))).plaintext;
});

afterAll(async () => {
  await gateway.shutdown();
});

const stats = (id: string) => (gateway.registry.deployment(id)?.provider as MockProvider).stats();

/** A prompt of its own per test, so tests never share a flight. */
const body = (model: string, stream = false) => ({
  model,
  messages: [{ role: 'user', content: `Say hello ${randomBytes(4).toString('hex')}` }],
  temperature: 0,
  stream,
});

function send(
  payload: Record<string, unknown>,
  { project = 'a', signal }: { project?: 'a' | 'b'; signal?: AbortSignal } = {},
) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[project]}` },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
}

async function reply(res: Promise<Response>) {
  const r = await res;
  return {
    status: r.status,
    cache: r.headers.get('x-gateway-cache'),
    id: r.headers.get('x-request-id')!,
    text: await r.text(),
  };
}

/** Waits until the worker has stored every one of the requests. */
async function records(ids: string[]) {
  let rows: { id: string; coalesced: boolean; status: string; attempt_count: number }[] = [];
  await vi.waitFor(
    async () => {
      rows = await gateway.db
        .selectFrom('request_records')
        .select(['id', 'coalesced', 'status', 'attempt_count'])
        .where('id', 'in', ids)
        .execute();
      expect(rows).toHaveLength(ids.length);
    },
    { timeout: 15_000, interval: 200 },
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Resolves once the deployment has `n` calls in progress. */
const upstreamActive = (id: string, n = 1) =>
  vi.waitFor(() => expect(stats(id).active).toBe(n), { timeout: 5_000, interval: 10 });

describe('request coalescing', () => {
  it('answers 50 identical concurrent requests with one upstream call and 50 records', async () => {
    const before = stats('slow').requests;
    const payload = body('mock-slow');
    const leader = reply(send(payload));
    await upstreamActive('slow');
    const followers = Array.from({ length: 49 }, (_, i) =>
      reply(send({ ...payload, stream: i % 4 === 0 })),
    );
    const all = await Promise.all([leader, ...followers]);
    expect(stats('slow').requests - before).toBe(1);
    expect(all.map((r) => r.status)).toEqual(Array(50).fill(200));
    expect(all.filter((r) => r.cache === 'coalesced')).toHaveLength(49);
    for (const [i, r] of all.slice(1).entries()) {
      if (i % 4 === 0) expect(sseData(r.text).at(-1)).toBe('[DONE]');
    }
    const stored = await records(all.map((r) => r.id));
    expect([...stored.values()].filter((r) => r.coalesced)).toHaveLength(49);
    expect(stored.get(all[0].id)).toMatchObject({ coalesced: false, attempt_count: 1 });
    for (const r of all.slice(1)) {
      expect(stored.get(r.id)).toMatchObject({
        coalesced: true,
        attempt_count: 0,
        status: 'success',
      });
    }
    // Followers cost nothing.
    const costs = await gateway.db
      .selectFrom('usage_events')
      .select(['request_id', 'cost_micro_usd', 'deployment'])
      .where(
        'request_id',
        'in',
        all.slice(1).map((r) => r.id),
      )
      .execute();
    expect(costs).toHaveLength(49);
    expect(costs.every((c) => Number(c.cost_micro_usd) === 0 && c.deployment === null)).toBe(true);
  });

  it("keeps the call going for followers when the leader's client leaves", async () => {
    const before = stats('trickle');
    const payload = body('mock-trickle', true);
    const gone = new AbortController();
    const leaderRes = await send(payload, { signal: gone.signal });
    const leaderId = leaderRes.headers.get('x-request-id')!;
    const reader = leaderRes.body!.getReader();
    await reader.read();
    const followers = Array.from({ length: 3 }, () => reply(send({ ...payload, stream: false })));
    // Let the followers join before the leader leaves.
    await new Promise((resolve) => setTimeout(resolve, 300));
    gone.abort();
    const answered = await Promise.all(followers);
    expect(answered.map((r) => [r.status, r.cache])).toEqual(Array(3).fill([200, 'coalesced']));
    const after = stats('trickle');
    expect(after.requests - before.requests).toBe(1);
    // The upstream stream ran to its end for the followers.
    expect(after.canceled - before.canceled).toBe(0);
    const stored = await records([leaderId, ...answered.map((r) => r.id)]);
    // The leader is recorded as cancelled, with the attempt that served everyone.
    expect(stored.get(leaderId)).toMatchObject({ status: 'canceled', attempt_count: 1 });
  });

  it('lets a follower leave early without affecting the others', async () => {
    const before = stats('slow');
    const payload = body('mock-slow');
    const leader = reply(send(payload));
    await upstreamActive('slow');
    const gone = new AbortController();
    const leaving = send(payload, { signal: gone.signal }).catch((err: unknown) => err);
    const staying = Array.from({ length: 2 }, () => reply(send(payload)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    gone.abort();
    expect(await leaving).toBeInstanceOf(Error);
    const answered = await Promise.all([leader, ...staying]);
    expect(answered.map((r) => r.status)).toEqual([200, 200, 200]);
    const after = stats('slow');
    expect(after.requests - before.requests).toBe(1);
    expect(after.canceled - before.canceled).toBe(0);
  });

  it('never shares a call between two projects', async () => {
    const before = stats('slow').requests;
    const payload = body('mock-slow');
    const a = reply(send(payload, { project: 'a' }));
    await upstreamActive('slow');
    const b = reply(send(payload, { project: 'b' }));
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(rb.cache).toBeNull();
    expect(stats('slow').requests - before).toBe(2);
  });
});
