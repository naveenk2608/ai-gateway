import type { AddressInfo } from 'node:net';
import { uuidv7 } from '@ai-gateway/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

// Routing edited from the dashboard (M15, ADR 034): two gateway instances sharing Postgres and
// Redis; a change made through one is used by the other.
const models = parseModelsConfig(
  {
    deployments: {
      first: { provider: 'mock', mock: { completionTokens: 2 } },
      second: { provider: 'mock', mock: { completionTokens: 2 } },
      spare: { provider: 'mock', mock: { completionTokens: 2 } },
    },
    models: {
      'mock-pair': {
        policy: 'priority',
        targets: [{ deployment: 'first' }, { deployment: 'second' }],
      },
    },
  },
  'route-overrides-test',
);

let a: Gateway;
let b: Gateway;
const urls = { a: '', b: '' };
let projectId: string;
let apiKey: string;
let admin: string;
let viewer: string;

const start = async (overrides: Record<string, string> = {}) => {
  const gateway = createGateway(testConfig(overrides), captureLogger().logger, { models });
  await gateway.start();
  return gateway;
};
const urlOf = (g: Gateway) => `http://127.0.0.1:${(g.app.server.address() as AddressInfo).port}`;

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${urls.a}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}

beforeAll(async () => {
  a = await start();
  // A short refresh, to see a lost message made up for within the interval.
  b = await start({ ROUTE_OVERRIDES_REFRESH_MS: '1000' });
  urls.a = urlOf(a);
  urls.b = urlOf(b);
  projectId = await createProject(a.db);
  apiKey = (await createApiKey(a.db, projectId)).plaintext;
  const adminUser = await createUser(a.db, [{ projectId, role: 'admin' }]);
  const viewerUser = await createUser(a.db, [{ projectId, role: 'viewer' }]);
  admin = await login(adminUser.email, adminUser.password);
  viewer = await login(viewerUser.email, viewerUser.password);
});

afterAll(async () => {
  await Promise.all([a.shutdown(), b.shutdown()]);
});

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${urls.a}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** The deployment that answered a chat request on one instance. */
async function served(instance: 'a' | 'b'): Promise<string | null> {
  const res = await fetch(`${urls[instance]}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'mock-pair', messages: [{ role: 'user', content: 'hi' }] }),
  });
  await res.text();
  return res.headers.get('x-gateway-deployment');
}

const routePath = `/admin/projects/${'{p}'}/routes/mock-pair`;
const path = (suffix = '') => routePath.replace('{p}', projectId) + suffix;
const secondFirst = {
  policy: 'priority',
  targets: [{ deployment: 'second' }, { deployment: 'first' }],
};

describe('route overrides across instances', () => {
  it('uses a change made through one instance on the other within seconds, then rolls back and resets', async () => {
    expect([await served('a'), await served('b')]).toEqual(['first', 'first']);

    const changed = await api<{ version: number }>('PUT', path(), admin, secondFirst);
    expect(changed).toEqual({
      status: 200,
      body: {
        version: 1,
        route: {
          ...secondFirst,
          targets: secondFirst.targets.map((t) => ({ ...t, weight: 1, lastResort: false })),
        },
      },
    });
    const before = Date.now();
    await vi.waitFor(async () => expect(await served('b')).toBe('second'), {
      timeout: 5_000,
      interval: 50,
    });
    // Reloaded through the invalidation message, well before B's 1 s refresh would matter twice.
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(await served('a')).toBe('second');

    // Back to the file's order as version 2, then roll back to version 1 (a new version 3).
    await api('PUT', path(), admin, {
      policy: 'priority',
      targets: [{ deployment: 'first' }, { deployment: 'second' }],
    });
    await vi.waitFor(async () => expect(await served('b')).toBe('first'), { timeout: 5_000 });
    const rolledBack = await api<{ version: number }>('POST', path('/rollback'), admin, {
      version: 1,
    });
    expect(rolledBack.body.version).toBe(3);
    await vi.waitFor(async () => expect(await served('b')).toBe('second'), { timeout: 5_000 });

    const reset = await api<{ version: number; route: null }>('POST', path('/reset'), admin);
    expect(reset.body).toEqual({ version: 4, route: null });
    await vi.waitFor(async () => expect(await served('b')).toBe('first'), { timeout: 5_000 });

    const history = await api<{
      versions: { version: number; action: string; rolledBackTo: number | null }[];
    }>('GET', path('/history'), viewer);
    expect(history.body.versions.map((v) => [v.version, v.action, v.rolledBackTo])).toEqual([
      [4, 'reset', null],
      [3, 'rollback', 1],
      [2, 'change', null],
      [1, 'change', null],
    ]);
    const audit = await a.db
      .selectFrom('audit_logs')
      .select('action')
      .where('project_id', '=', projectId)
      .where('target_type', '=', 'model_route')
      .orderBy('created_at')
      .execute();
    expect(audit.map((r) => r.action)).toEqual([
      'route.update',
      'route.update',
      'route.rollback',
      'route.reset',
    ]);
  });

  it('picks up a change whose message was lost within the refresh interval', async () => {
    const latest = await a.db
      .selectFrom('route_overrides')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    // Written straight to Postgres: no message is published.
    await a.db
      .insertInto('route_overrides')
      .values({
        id: uuidv7(),
        project_id: projectId,
        model: 'mock-pair',
        version: (latest?.v ?? 0) + 1,
        action: 'change',
        route: JSON.stringify({
          policy: 'priority',
          targets: [
            { deployment: 'second', weight: 1, lastResort: false },
            { deployment: 'first', weight: 1, lastResort: false },
          ],
        }),
      })
      .execute();
    await vi.waitFor(async () => expect(await served('b')).toBe('second'), {
      timeout: 3_000,
      interval: 100,
    });
    await api('POST', path('/reset'), admin);
  });

  it('refuses an invalid override with a clear error, and a viewer', async () => {
    const outside = await api<{ error: { code: string; message: string } }>('PUT', path(), admin, {
      policy: 'priority',
      targets: [{ deployment: 'spare' }, { deployment: 'first' }, { deployment: 'first' }],
    });
    expect(outside.status).toBe(400);
    expect(outside.body.error.code).toBe('invalid_route');
    expect(outside.body.error.message).toContain(
      '"spare" is not a deployment of this model in the models file (allowed: first, second)',
    );
    expect(outside.body.error.message).toContain('"first" is listed twice');
    const unknown = await api(
      'PUT',
      `/admin/projects/${projectId}/routes/no-such-model`,
      admin,
      secondFirst,
    );
    expect(unknown.status).toBe(404);
    const asViewer = await api<{ error: { code: string } }>('PUT', path(), viewer, secondFirst);
    expect(asViewer.status).toBe(403);
    expect(asViewer.body.error.code).toBe('insufficient_role');
    const listed = await api<{ enabled: boolean; models: { name: string }[] }>(
      'GET',
      `/admin/projects/${projectId}/routes`,
      viewer,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.models.map((m) => m.name)).toEqual(['mock-pair']);
  });
});
