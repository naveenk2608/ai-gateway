/**
 * M5 acceptance: failover, circuit-breaker recovery, no retry after the first streamed byte, and
 * the routing history of each request.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { closeRedis, createRedis, type Redis } from '@ai-gateway/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, sseData, testConfig } from './helpers.js';

const tag = randomBytes(3).toString('hex');
/** Deployment ids of their own, so health rows from other runs never match. */
const primary = `primary-${tag}`;
const secondary = `secondary-${tag}`;
const dropping = `dropping-${tag}`;
const coldStart = `cold-${tag}`;

const models = parseModelsConfig(
  {
    deployments: {
      [primary]: { provider: 'mock', mock: { completionTokens: 3, failWith: 500 } },
      [secondary]: { provider: 'mock', mock: { completionTokens: 3 } },
      // Streams two tokens, then drops the connection.
      [dropping]: { provider: 'mock', mock: { completionTokens: 10, dropAfterTokens: 2 } },
      // Fails before its first token.
      [coldStart]: { provider: 'mock', mock: { failWith: 500 } },
    },
    models: {
      'mock-failover': {
        policy: 'priority',
        targets: [{ deployment: primary }, { deployment: secondary }],
      },
      'mock-drop-first': { targets: [{ deployment: dropping }, { deployment: secondary }] },
      'mock-cold-first': { targets: [{ deployment: coldStart }, { deployment: secondary }] },
    },
  },
  'routing-acceptance',
);

let gateway: Gateway;
let url: string;
let key: string;
let cookie: string;
let redis: Redis;

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:routing:${tag}`,
      EVENTS_DLQ_STREAM: `test:routing:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `routing-${tag}`,
      WORKER_BLOCK_MS: '100',
      // One try per deployment, so each failover is exactly two attempts.
      RETRY_PER_DEPLOYMENT: '1',
      BREAKER_FAILURE_THRESHOLD: '3',
      // Long enough that only the active health check can half-open the breaker.
      BREAKER_OPEN_MS: '600000',
      HEALTH_CHECK_INTERVAL_MS: '200',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  redis = createRedis(process.env.REDIS_URL!, captureLogger().logger, { offlineQueue: true });
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  const projectId = await createProject(gateway.db);
  key = (await createApiKey(gateway.db, projectId)).plaintext;
  const viewer = await createUser(gateway.db, [{ projectId, role: 'viewer' }]);
  const login = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: viewer.email, password: viewer.password }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await Promise.all([gateway.shutdown(), closeRedis(redis)]);
});

const mock = (id: string) => gateway.registry.deployment(id)?.provider as MockProvider;

async function chat(model: string, stream = false) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'Say hello' }] }),
  });
  return { status: res.status, body: await res.text(), id: res.headers.get('x-request-id')! };
}

interface Attempt {
  attemptNumber: number;
  deployment: string;
  outcome: string;
  routingPolicy: string | null;
  routingReason: string | null;
}

/** The routing history the admin API shows for a request, once the worker has stored it. */
async function history(requestId: string): Promise<Attempt[]> {
  let attempts: Attempt[] = [];
  await vi.waitFor(
    async () => {
      const res = await fetch(`${url}/admin/requests/${requestId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      attempts = ((await res.json()) as { attempts: Attempt[] }).attempts;
    },
    { timeout: 10_000, interval: 100 },
  );
  return attempts.map(({ attemptNumber, deployment, outcome, routingPolicy, routingReason }) => ({
    attemptNumber,
    deployment,
    outcome,
    routingPolicy,
    routingReason,
  }));
}

async function transitions(deployment: string) {
  const rows = await gateway.db
    .selectFrom('provider_health_events')
    .select(['from_state', 'to_state', 'reason'])
    .where('deployment', '=', deployment)
    .orderBy('id')
    .execute();
  return rows.map((r) => `${r.from_state}->${r.to_state}: ${r.reason}`);
}

describe('failover and circuit breaker', () => {
  it('fails over while the primary fails, opens its breaker, and recovers when it heals', async () => {
    // The primary fails every request: each one is served by the secondary.
    const failedOver = [];
    for (let i = 0; i < 3; i++) failedOver.push(await chat('mock-failover'));
    expect(failedOver.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(mock(primary).stats().requests).toBe(3);
    expect(gateway.breakers.get(primary).state).toBe('open');

    // Routing history of a failed-over request: each attempt with its reason.
    expect(await history(failedOver[0]!.id)).toEqual([
      {
        attemptNumber: 1,
        deployment: primary,
        outcome: 'server_error',
        routingPolicy: 'priority',
        routingReason: 'priority 1 of 2',
      },
      {
        attemptNumber: 2,
        deployment: secondary,
        outcome: 'success',
        routingPolicy: 'priority',
        routingReason: `priority 2 of 2; fallback after ${primary} failed (server_error)`,
      },
    ]);

    // Open: the primary is not called at all.
    const skipped = await chat('mock-failover');
    expect(skipped.status).toBe(200);
    expect(mock(primary).stats().requests).toBe(3);
    expect(await history(skipped.id)).toEqual([
      expect.objectContaining({
        deployment: secondary,
        routingReason: `priority 2 of 2; skipped ${primary} (circuit open)`,
      }),
    ]);

    // The primary heals; the active health check half-opens the breaker without waiting 10 min.
    mock(primary).update({ failWith: undefined });
    await vi.waitFor(() => expect(gateway.breakers.get(primary).state).toBe('half_open'), {
      timeout: 5_000,
      interval: 50,
    });
    // The next request is the trial; it succeeds and closes the breaker.
    const trial = await chat('mock-failover');
    expect(trial.status).toBe(200);
    expect(gateway.breakers.get(primary).state).toBe('closed');
    expect(await history(trial.id)).toEqual([
      expect.objectContaining({ deployment: primary, outcome: 'success', attemptNumber: 1 }),
    ]);

    await vi.waitFor(async () =>
      expect(await transitions(primary)).toEqual([
        'closed->open: 3 consecutive failures (last: server_error)',
        'open->half_open: health check passed',
        'half_open->closed: trial request succeeded',
      ]),
    );
    // The fleet view in Redis shows this instance's latest state.
    const states = Object.values(await redis.hgetall(`gw:health:${primary}`));
    expect(states.map((s) => (JSON.parse(s) as { state: string }).state)).toEqual(['closed']);
  });
});

describe('streams', () => {
  it('never retries after the first byte has been streamed', async () => {
    const before = mock(secondary).stats().requests;
    const res = await chat('mock-drop-first', true);
    expect(res.status).toBe(200);
    const events = sseData(res.body);
    expect(events).not.toContain('[DONE]');
    expect(JSON.parse(events.at(-1)!)).toMatchObject({ error: { code: 'upstream_unavailable' } });
    // The drop is retryable, yet nothing else was tried: the client already has output.
    expect(mock(dropping).stats().requests).toBe(1);
    expect(mock(secondary).stats().requests).toBe(before);
    expect(await history(res.id)).toEqual([
      expect.objectContaining({ deployment: dropping, outcome: 'connection', attemptNumber: 1 }),
    ]);
  });

  it('falls back when a stream fails before its first byte', async () => {
    const res = await chat('mock-cold-first', true);
    expect(sseData(res.body).at(-1)).toBe('[DONE]');
    expect((await history(res.id)).map((a) => [a.deployment, a.outcome])).toEqual([
      [coldStart, 'server_error'],
      [secondary, 'success'],
    ]);
  });
});
