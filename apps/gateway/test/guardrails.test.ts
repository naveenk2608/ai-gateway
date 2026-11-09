import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

// Guardrails (M16, ADR 035) through the real gateway and worker: a policy set in the admin API
// applies at once, and what the checks did shows in the results and the counts.
const tag = randomBytes(3).toString('hex');
const models = parseModelsConfig(
  {
    deployments: { quick: { provider: 'mock', mock: { completionTokens: 2 } } },
    models: { 'mock-a': { deployment: 'quick' } },
  },
  'guardrails-test',
);

let gateway: Gateway;
let url: string;
let projectId: string;
let apiKey: string;
let admin: string;
let viewer: string;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${url}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

beforeAll(async () => {
  gateway = createGateway(
    testConfig({
      RUN_WORKER_IN_PROCESS: 'true',
      EVENTS_STREAM: `test:guard:${tag}`,
      EVENTS_DLQ_STREAM: `test:guard:${tag}:dlq`,
      EVENTS_CONSUMER_GROUP: `guard-${tag}`,
      WORKER_BLOCK_MS: '100',
    }),
    captureLogger().logger,
    { models },
  );
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  projectId = await createProject(gateway.db);
  apiKey = (await createApiKey(gateway.db, projectId)).plaintext;
  const a = await createUser(gateway.db, [{ projectId, role: 'admin' }]);
  const v = await createUser(gateway.db, [{ projectId, role: 'viewer' }]);
  admin = await login(a.email, a.password);
  viewer = await login(v.email, v.password);
});

afterAll(async () => {
  await gateway.shutdown();
});

async function api<T>(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const chat = (content: string) =>
  fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content }] }),
  });

describe('guardrails end to end', () => {
  it('applies a policy at once, and lists and counts what it masked and blocked', async () => {
    const base = `/admin/projects/${projectId}/guardrails`;
    expect((await api<{ policy: unknown }>('GET', base, viewer)).body.policy).toMatchObject({
      input: { email: 'off', card: 'off' },
    });
    // A request before any policy goes through as it is.
    expect((await chat('card 4111 1111 1111 1111')).status).toBe(200);

    const saved = await api('PUT', base, admin, { input: { email: 'mask', card: 'block' } });
    expect(saved.status).toBe(200);
    expect((await api('PUT', base, viewer, {})).status).toBe(403);

    const masked = await chat('mail jane@example.com');
    expect(masked.status).toBe(200);
    const maskedId = masked.headers.get('x-request-id')!;
    const blocked = await chat('card 4111 1111 1111 1111');
    expect(blocked.status).toBe(400);
    const blockedId = blocked.headers.get('x-request-id')!;

    type Results = {
      data: { requestId: string; check: string; action: string; findings: number }[];
    };
    await vi.waitFor(
      async () => {
        const all = await api<Results>('GET', `${base}/results?range=1h`, viewer);
        expect(all.body.data.map((r) => r.requestId).sort()).toEqual([maskedId, blockedId].sort());
      },
      { timeout: 15_000, interval: 200 },
    );
    const onlyBlocked = await api<Results>('GET', `${base}/results?range=1h&action=block`, viewer);
    expect(onlyBlocked.body.data).toEqual([
      expect.objectContaining({
        requestId: blockedId,
        check: 'card',
        action: 'block',
        findings: 1,
      }),
    ]);
    // Results never carry a value.
    expect(JSON.stringify(onlyBlocked.body)).not.toContain('4111');
    const summary = await api<{ requests: Record<string, number> }>(
      'GET',
      `${base}/summary?range=1h`,
      viewer,
    );
    expect(summary.body.requests).toEqual({ blocked: 1, flagged: 0, masked: 1 });
  });
});
