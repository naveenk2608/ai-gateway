import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/** Deployment ids of their own, so the quota and cooldown keys in Redis are this file's alone. */
const tag = randomBytes(4).toString('hex');
const daily = `daily-${tag}`;
const flaky = `flaky-${tag}`;

/**
 * Two gateway instances sharing Postgres and Redis. On instance A the `flaky` deployment answers
 * every request with a 429; on instance B the deployment with the same id is healthy, so B can
 * only refuse it because of the cooldown A stored in Redis.
 */
function models(flakyFails: boolean) {
  return parseModelsConfig(
    {
      deployments: {
        [daily]: {
          adapter: 'mock',
          mock: { completionTokens: 3 },
          quota: { requestsPerDay: 3 },
        },
        [flaky]: {
          adapter: 'mock',
          mock: flakyFails ? { failWith: 429, retryAfterMs: 20_000 } : { completionTokens: 3 },
        },
        backup: { adapter: 'mock', mock: { completionTokens: 3 } },
      },
      models: {
        'quota-then-backup': {
          policy: 'priority',
          targets: [{ deployment: daily }, { deployment: 'backup' }],
        },
        'quota-only': { deployment: daily },
        'flaky-only': { deployment: flaky },
      },
    },
    'quota-test',
  );
}

let a: Gateway;
let b: Gateway;
let urlA: string;
let urlB: string;
let key: string;
let cookie: string;

const urlOf = (g: Gateway) => `http://127.0.0.1:${(g.app.server.address() as AddressInfo).port}`;

beforeAll(async () => {
  const shared = {
    EVENTS_STREAM: `test:quota:${tag}`,
    EVENTS_DLQ_STREAM: `test:quota:${tag}:dlq`,
    EVENTS_CONSUMER_GROUP: `quota-${tag}`,
    WORKER_BLOCK_MS: '100',
    // Retries would wait out the 20 s Retry-After; one try per deployment keeps the test quick.
    RETRY_PER_DEPLOYMENT: '1',
  };
  a = createGateway(
    testConfig({ ...shared, RUN_WORKER_IN_PROCESS: 'true' }),
    captureLogger().logger,
    { models: models(true) },
  );
  b = createGateway(testConfig(shared), captureLogger().logger, { models: models(false) });
  await Promise.all([a.start(), b.start()]);
  urlA = urlOf(a);
  urlB = urlOf(b);

  const projectId = await createProject(a.db);
  key = (await createApiKey(a.db, projectId)).plaintext;
  const user = await createUser(a.db, [{ projectId, role: 'viewer' }]);
  const res = await fetch(`${urlA}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

afterAll(async () => {
  await Promise.all([a?.shutdown(), b?.shutdown()]);
});

async function chat(url: string, model: string) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = (await res.json()) as { error?: { code: string } };
  return {
    status: res.status,
    code: body.error?.code,
    requestId: res.headers.get('x-request-id')!,
    deployment: res.headers.get('x-gateway-deployment'),
    retryAfter: res.headers.get('retry-after'),
  };
}

async function attempts(requestId: string) {
  let found: { deployment: string; routingReason: string | null }[] = [];
  await vi.waitFor(
    async () => {
      const res = await fetch(`${urlA}/admin/requests/${requestId}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      found = ((await res.json()) as { attempts: typeof found }).attempts;
    },
    { timeout: 10_000, interval: 100 },
  );
  return found;
}

describe('free-tier quotas (ADR 025)', () => {
  it('skips a deployment with a quota of 3 requests a day on the 4th, and stores why', async () => {
    // Three requests across both instances use up the shared daily quota.
    for (const url of [urlA, urlB, urlA]) {
      expect(await chat(url, 'quota-then-backup')).toMatchObject({
        status: 200,
        deployment: daily,
      });
    }
    const fourth = await chat(urlB, 'quota-then-backup');
    expect(fourth).toMatchObject({ status: 200, deployment: 'backup' });
    const [attempt] = await attempts(fourth.requestId);
    expect(attempt?.deployment).toBe('backup');
    expect(attempt?.routingReason).toContain(`skipped ${daily} (quota, 3 of 3 requests today)`);

    // With no other deployment, the request is refused until the UTC day ends.
    const refused = await chat(urlA, 'quota-only');
    expect(refused).toMatchObject({ status: 429, code: 'upstream_quota_exhausted' });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    expect(Number(refused.retryAfter)).toBeLessThanOrEqual(86_400);
  });

  it('shows the quota use to the dashboard', async () => {
    const res = await fetch(`${urlA}/admin/models/quotas`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deployments: { deployment: string; limits: unknown; today: { requests: number } }[];
    };
    expect(body.deployments.find((d) => d.deployment === daily)).toMatchObject({
      limits: { requestsPerDay: 3, requestsPerMinute: null },
      today: { requests: 3 },
    });
  });
});

describe('429 cooldowns shared by instances (ADR 025)', () => {
  it('skips a deployment on every instance once one instance got a 429 from it', async () => {
    // Before any 429, instance B's healthy copy of the deployment answers.
    expect(await chat(urlB, 'flaky-only')).toMatchObject({ status: 200, deployment: flaky });

    // Instance A gets a 429 with Retry-After 20 s: the deployment cools down in Redis.
    expect(await chat(urlA, 'flaky-only')).toMatchObject({
      status: 429,
      code: 'upstream_rate_limited',
    });
    // B now skips it without calling it, though its own copy would have answered.
    await vi.waitFor(async () => {
      const skipped = await chat(urlB, 'flaky-only');
      expect(skipped).toMatchObject({ status: 429, code: 'upstream_rate_limited' });
      expect(Number(skipped.retryAfter)).toBeGreaterThan(0);
      expect(Number(skipped.retryAfter)).toBeLessThanOrEqual(20);
    });

    const res = await fetch(`${urlA}/admin/models/quotas`, { headers: { cookie } });
    const body = (await res.json()) as {
      deployments: { deployment: string; cooldownUntil: string | null }[];
    };
    expect(body.deployments.find((d) => d.deployment === flaky)?.cooldownUntil).not.toBeNull();
  });
});
