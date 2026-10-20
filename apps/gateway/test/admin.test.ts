import type { AddressInfo } from 'node:net';
import { systemClock, type Clock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject, createUser, type TestUser } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

const models = parseModelsConfig(
  {
    deployments: { quick: { provider: 'mock', mock: { completionTokens: 2 } } },
    models: { 'mock-a': { deployment: 'quick' } },
  },
  'admin-test',
);

/** Real time plus an offset the test controls (for rotation grace periods). */
let offset = 0;
const clock: Clock = {
  now: () => Date.now() + offset,
  sleep: (ms, signal) => systemClock.sleep(ms, signal),
};

let gateway: Gateway;
let other: Gateway;
let url: string;
let otherUrl: string;
let db: Db;
/** Every route the gateway registers, as `METHOD /path`. */
const routes: string[] = [];

function start(overrides: Record<string, string> = {}) {
  return createGateway(testConfig(overrides), captureLogger().logger, { models, clock });
}

beforeAll(async () => {
  gateway = start();
  gateway.app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
    }
  });
  await gateway.start();
  url = `http://127.0.0.1:${(gateway.app.server.address() as AddressInfo).port}`;
  db = gateway.db;
  // A second instance with a long cache TTL: revocations must reach it through pub/sub.
  other = start({ API_KEY_CACHE_TTL_MS: '120000' });
  await other.start();
  otherUrl = `http://127.0.0.1:${(other.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([gateway.shutdown(), other.shutdown()]);
});

interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<Res<T>> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

async function login(user: TestUser): Promise<string> {
  const res = await api('POST', '/admin/auth/login', undefined, {
    email: user.email,
    password: user.password,
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0]!;
}

function chat(base: string, key: string) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'mock-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('admin login and sessions', () => {
  it('sets an HTTP-only, SameSite=Strict session cookie and ends it on logout', async () => {
    const user = await createUser(db);
    const res = await api('POST', '/admin/auth/login', undefined, {
      email: user.email.toUpperCase(),
      password: user.password,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: user.id, email: user.email } });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^gw_session=[\w-]{43};/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;

    expect((await api('GET', '/admin/me', cookie)).status).toBe(200);
    expect((await api('POST', '/admin/auth/logout', cookie)).status).toBe(204);
    expect((await api('GET', '/admin/me', cookie)).status).toBe(401);
  });

  it('rejects a wrong password and an unknown email the same way', async () => {
    const user = await createUser(db);
    const wrong = await api('POST', '/admin/auth/login', undefined, {
      email: user.email,
      password: 'not-the-password',
    });
    const unknown = await api('POST', '/admin/auth/login', undefined, {
      email: 'nobody@example.test',
      password: 'not-the-password',
    });
    expect(wrong).toMatchObject({ status: 401, body: { error: { code: 'invalid_credentials' } } });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('requires a session on every admin route but login', async () => {
    expect(await api('GET', '/admin/projects')).toMatchObject({
      status: 401,
      body: { error: { code: 'not_authenticated' } },
    });
    expect((await api('GET', '/admin/me', 'gw_session=forged')).status).toBe(401);
  });
});

/** Two projects, A and B, each with resources the other must never reach. */
async function twoProjects() {
  const a = await createProject(db);
  const b = await createProject(db);
  const ownerA = await createUser(db, [{ projectId: a, role: 'owner' }]);
  const ownerB = await createUser(db, [{ projectId: b, role: 'owner' }]);
  const keyA = await createApiKey(db, a);
  const keyB = await createApiKey(db, b);
  return { a, b, ownerA, ownerB, keyA, keyB, cookieA: await login(ownerA) };
}

describe('project isolation', () => {
  it('returns 404, not 403, for another project on every project-scoped admin route', async () => {
    const t = await twoProjects();
    // [route, path into project B, body]
    const cases: [string, string, unknown?][] = [
      ['GET /admin/projects/:projectId', `/admin/projects/${t.b}`],
      ['PATCH /admin/projects/:projectId', `/admin/projects/${t.b}`, { name: 'taken' }],
      ['GET /admin/projects/:projectId/members', `/admin/projects/${t.b}/members`],
      [
        'POST /admin/projects/:projectId/members',
        `/admin/projects/${t.b}/members`,
        { email: t.ownerA.email, role: 'owner' },
      ],
      [
        'PATCH /admin/projects/:projectId/members/:userId',
        `/admin/projects/${t.b}/members/${t.ownerB.id}`,
        { role: 'viewer' },
      ],
      [
        'DELETE /admin/projects/:projectId/members/:userId',
        `/admin/projects/${t.b}/members/${t.ownerB.id}`,
      ],
      ['GET /admin/projects/:projectId/api-keys', `/admin/projects/${t.b}/api-keys`],
      [
        'POST /admin/projects/:projectId/api-keys',
        `/admin/projects/${t.b}/api-keys`,
        { name: 'x' },
      ],
      [
        'POST /admin/projects/:projectId/api-keys/:apiKeyId/revoke',
        `/admin/projects/${t.b}/api-keys/${t.keyB.id}/revoke`,
      ],
      [
        'POST /admin/projects/:projectId/api-keys/:apiKeyId/rotate',
        `/admin/projects/${t.b}/api-keys/${t.keyB.id}/rotate`,
        {},
      ],
      ['GET /admin/projects/:projectId/audit-logs', `/admin/projects/${t.b}/audit-logs`],
    ];

    // The table covers every registered route that takes a project.
    const scoped = routes.filter((r) => r.includes(':projectId'));
    expect(cases.map(([route]) => route).sort()).toEqual([...new Set(scoped)].sort());

    for (const [route, path, body] of cases) {
      const res = await api(route.split(' ')[0]!, path, t.cookieA, body);
      expect({
        route,
        status: res.status,
        code: (res.body as { error?: { code: string } }).error?.code,
      }).toEqual({ route, status: 404, code: 'project_not_found' });
    }

    // Nothing in B changed.
    const keyB = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', t.keyB.id)
      .executeTakeFirstOrThrow();
    expect(keyB.revoked_at).toBeNull();
    expect(keyB.rotated_to).toBeNull();
    expect((await chat(url, t.keyB.plaintext)).status).toBe(200);
  });

  it("returns 404 for another project's key or member under one's own project", async () => {
    const t = await twoProjects();
    const revoke = await api(
      'POST',
      `/admin/projects/${t.a}/api-keys/${t.keyB.id}/revoke`,
      t.cookieA,
    );
    expect(revoke).toMatchObject({ status: 404, body: { error: { code: 'api_key_not_found' } } });
    const rotate = await api(
      'POST',
      `/admin/projects/${t.a}/api-keys/${t.keyB.id}/rotate`,
      t.cookieA,
      {},
    );
    expect(rotate.status).toBe(404);
    const member = await api('PATCH', `/admin/projects/${t.a}/members/${t.ownerB.id}`, t.cookieA, {
      role: 'viewer',
    });
    expect(member).toMatchObject({ status: 404, body: { error: { code: 'member_not_found' } } });
    expect(
      (await api('DELETE', `/admin/projects/${t.a}/members/${t.ownerB.id}`, t.cookieA)).status,
    ).toBe(404);
  });

  it('lists only the projects and keys of the caller', async () => {
    const t = await twoProjects();
    const projects = await api<{ data: { id: string }[] }>('GET', '/admin/projects', t.cookieA);
    expect(projects.body.data.map((p) => p.id)).toEqual([t.a]);
    const keys = await api<{ data: { id: string }[] }>(
      'GET',
      `/admin/projects/${t.a}/api-keys`,
      t.cookieA,
    );
    expect(keys.body.data.map((k) => k.id)).toEqual([t.keyA.id]);
  });
});

describe('roles', () => {
  it('lets viewers read but not change, and only owners manage members', async () => {
    const p = await createProject(db);
    const viewer = await createUser(db, [{ projectId: p, role: 'viewer' }]);
    const admin = await createUser(db, [{ projectId: p, role: 'admin' }]);
    const viewerCookie = await login(viewer);
    const adminCookie = await login(admin);

    expect((await api('GET', `/admin/projects/${p}`, viewerCookie)).status).toBe(200);
    expect((await api('GET', `/admin/projects/${p}/api-keys`, viewerCookie)).status).toBe(200);
    for (const [method, path, body] of [
      ['PATCH', `/admin/projects/${p}`, { name: 'renamed' }],
      ['POST', `/admin/projects/${p}/api-keys`, { name: 'k' }],
      ['GET', `/admin/projects/${p}/audit-logs`],
    ] as const) {
      expect(await api(method, path, viewerCookie, body)).toMatchObject({
        status: 403,
        body: { error: { code: 'insufficient_role' } },
      });
    }

    expect(
      (await api('POST', `/admin/projects/${p}/api-keys`, adminCookie, { name: 'k' })).status,
    ).toBe(201);
    expect(
      (
        await api('PATCH', `/admin/projects/${p}/members/${viewer.id}`, adminCookie, {
          role: 'admin',
        })
      ).status,
    ).toBe(403);
  });

  it('never leaves a project without an owner', async () => {
    const p = await createProject(db);
    const owner = await createUser(db, [{ projectId: p, role: 'owner' }]);
    const cookie = await login(owner);
    expect(
      await api('PATCH', `/admin/projects/${p}/members/${owner.id}`, cookie, { role: 'admin' }),
    ).toMatchObject({ status: 409, body: { error: { code: 'last_owner' } } });
    expect((await api('DELETE', `/admin/projects/${p}/members/${owner.id}`, cookie)).status).toBe(
      409,
    );
    // A failed change writes no audit row.
    const audits = await db
      .selectFrom('audit_logs')
      .select('action')
      .where('project_id', '=', p)
      .execute();
    expect(audits).toEqual([]);
  });
});

describe('audit log', () => {
  it('writes one audit row, tagged with the request ID, for every admin mutation', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const created = await api<{ id: string }>('POST', '/admin/projects', cookie, {
      name: 'audited',
    });
    const p = created.body.id;
    const key = await api<{ apiKey: { id: string } }>(
      'POST',
      `/admin/projects/${p}/api-keys`,
      cookie,
      {
        name: 'k1',
      },
    );
    const k1 = key.body.apiKey.id;
    const k2 = (
      await api<{ apiKey: { id: string } }>('POST', `/admin/projects/${p}/api-keys`, cookie, {
        name: 'k2',
      })
    ).body.apiKey.id;
    const member = await createUser(db);

    // [route, method, path, body, expected action]; the first two calls above are covered too.
    const cases: [string, Res, string][] = [
      ['POST /admin/projects', created, 'project.create'],
      ['POST /admin/projects/:projectId/api-keys', key, 'api_key.create'],
    ];
    const run = async (route: string, path: string, action: string, body?: unknown) => {
      cases.push([route, await api(route.split(' ')[0]!, path, cookie, body), action]);
    };
    await run('PATCH /admin/projects/:projectId', `/admin/projects/${p}`, 'project.update', {
      allowedModels: ['mock-a'],
    });
    await run(
      'POST /admin/projects/:projectId/members',
      `/admin/projects/${p}/members`,
      'member.add',
      {
        email: member.email,
        role: 'viewer',
      },
    );
    await run(
      'PATCH /admin/projects/:projectId/members/:userId',
      `/admin/projects/${p}/members/${member.id}`,
      'member.update',
      { role: 'admin' },
    );
    await run(
      'DELETE /admin/projects/:projectId/members/:userId',
      `/admin/projects/${p}/members/${member.id}`,
      'member.remove',
    );
    await run(
      'POST /admin/projects/:projectId/api-keys/:apiKeyId/rotate',
      `/admin/projects/${p}/api-keys/${k1}/rotate`,
      'api_key.rotate',
      { gracePeriodSeconds: 60 },
    );
    await run(
      'POST /admin/projects/:projectId/api-keys/:apiKeyId/revoke',
      `/admin/projects/${p}/api-keys/${k2}/revoke`,
      'api_key.revoke',
    );
    // Session mutations are audited without a project.
    const second = await api('POST', '/admin/auth/login', undefined, {
      email: owner.email,
      password: owner.password,
    });
    cases.push(['POST /admin/auth/login', second, 'auth.login']);
    await run('POST /admin/auth/logout', '/admin/auth/logout', 'auth.logout');

    // Every mutating admin route is in the table.
    const mutations = routes.filter((r) => /^(POST|PUT|PATCH|DELETE) \/admin\//.test(r));
    expect([...new Set(cases.map(([route]) => route))].sort()).toEqual(
      [...new Set(mutations)].sort(),
    );

    for (const [route, res, action] of cases) {
      expect({ route, succeeded: res.status < 300 }).toEqual({ route, succeeded: true });
      const requestId = res.headers.get('x-request-id')!;
      const rows = await db
        .selectFrom('audit_logs')
        .select(['action', 'actor_type', 'actor_user_id'])
        .where('request_id', '=', requestId)
        .execute();
      expect({ route, rows }).toEqual({
        route,
        rows: [{ action, actor_type: 'user', actor_user_id: owner.id }],
      });
    }

    // The log never carries secrets.
    const all = await db
      .selectFrom('audit_logs')
      .select('details')
      .where('project_id', '=', p)
      .execute();
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/gw_[0-9a-f]{16}_[0-9a-f]{64}/);
    expect(text).not.toMatch(/password|secret|hash/i);
  });

  it('pages the audit log newest first', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const p = (await api<{ id: string }>('POST', '/admin/projects', cookie, { name: 'paged' })).body
      .id;
    for (const name of ['a', 'b', 'c'])
      await api('POST', `/admin/projects/${p}/api-keys`, cookie, { name });
    const page1 = await api<{ data: { action: string; id: string }[]; nextBefore: string }>(
      'GET',
      `/admin/projects/${p}/audit-logs?limit=2`,
      cookie,
    );
    expect(page1.body.data).toHaveLength(2);
    const page2 = await api<{ data: { action: string }[]; nextBefore: string | null }>(
      'GET',
      `/admin/projects/${p}/audit-logs?limit=2&before=${page1.body.nextBefore}`,
      cookie,
    );
    expect(page2.body.data.map((e) => e.action)).toEqual(['api_key.create', 'project.create']);
  });
});

describe('API key lifecycle through the admin API', () => {
  it('shows the full key once and never again', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const p = (await api<{ id: string }>('POST', '/admin/projects', cookie, { name: 'keys' })).body
      .id;
    const created = await api<{ key: string; apiKey: { maskedKey: string; status: string } }>(
      'POST',
      `/admin/projects/${p}/api-keys`,
      cookie,
      { name: 'ci' },
    );
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(created.body.key).toMatch(/^gw_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(created.body.apiKey).toMatchObject({
      status: 'active',
      maskedKey: `${created.body.key.slice(0, 20)}…`,
    });
    expect((await chat(url, created.body.key)).status).toBe(200);

    const list = await api('GET', `/admin/projects/${p}/api-keys`, cookie);
    expect(JSON.stringify(list.body)).not.toContain(created.body.key.slice(20));
  });

  it('revocation applies at once here and reaches another instance through pub/sub', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const p = (await api<{ id: string }>('POST', '/admin/projects', cookie, { name: 'revoke' }))
      .body.id;
    const created = await api<{ key: string; apiKey: { id: string } }>(
      'POST',
      `/admin/projects/${p}/api-keys`,
      cookie,
      { name: 'k' },
    );
    // Cached on both instances.
    expect((await chat(url, created.body.key)).status).toBe(200);
    expect((await chat(otherUrl, created.body.key)).status).toBe(200);

    const revoked = await api(
      'POST',
      `/admin/projects/${p}/api-keys/${created.body.apiKey.id}/revoke`,
      cookie,
    );
    expect(revoked).toMatchObject({ status: 200, body: { status: 'revoked' } });
    expect((await chat(url, created.body.key)).status).toBe(401);
    // The other instance caches for 120 s; the invalidation message gets there far sooner.
    const started = Date.now();
    await vi.waitFor(
      async () => expect((await chat(otherUrl, created.body.key)).status).toBe(401),
      {
        timeout: 5_000,
        interval: 50,
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);

    const again = await api(
      'POST',
      `/admin/projects/${p}/api-keys/${created.body.apiKey.id}/revoke`,
      cookie,
    );
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'api_key_revoked' } } });
  });

  it('rotation issues a new key and keeps the old one only for the grace period', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const p = (await api<{ id: string }>('POST', '/admin/projects', cookie, { name: 'rotate' }))
      .body.id;
    const created = await api<{ key: string; apiKey: { id: string } }>(
      'POST',
      `/admin/projects/${p}/api-keys`,
      cookie,
      { name: 'k' },
    );
    const old = created.body.key;
    expect((await chat(otherUrl, old)).status).toBe(200); // cached before the rotation

    const rotated = await api<{
      key: string;
      apiKey: { id: string; status: string };
      previous: { status: string; rotatedTo: string; expiresAt: string };
    }>('POST', `/admin/projects/${p}/api-keys/${created.body.apiKey.id}/rotate`, cookie, {
      gracePeriodSeconds: 600,
    });
    expect(rotated.status).toBe(201);
    expect(rotated.body.apiKey.status).toBe('active');
    expect(rotated.body.previous).toMatchObject({
      status: 'expiring',
      rotatedTo: rotated.body.apiKey.id,
    });

    // Both keys work during the grace period, on both instances.
    for (const base of [url, otherUrl]) {
      expect((await chat(base, old)).status).toBe(200);
      expect((await chat(base, rotated.body.key)).status).toBe(200);
    }
    // After it, only the new key works, even on the instance that had the old key cached.
    offset = 600_000;
    try {
      for (const base of [url, otherUrl]) {
        expect((await chat(base, old)).status).toBe(401);
        expect((await chat(base, rotated.body.key)).status).toBe(200);
      }
    } finally {
      offset = 0;
    }

    const twice = await api(
      'POST',
      `/admin/projects/${p}/api-keys/${created.body.apiKey.id}/rotate`,
      cookie,
      {},
    );
    expect(twice).toMatchObject({
      status: 409,
      body: { error: { code: 'api_key_already_rotated' } },
    });
  });

  it('allow-list changes reach cached keys', async () => {
    const owner = await createUser(db);
    const cookie = await login(owner);
    const p = (await api<{ id: string }>('POST', '/admin/projects', cookie, { name: 'allow' })).body
      .id;
    const { key } = (
      await api<{ key: string }>('POST', `/admin/projects/${p}/api-keys`, cookie, { name: 'k' })
    ).body;
    expect((await chat(otherUrl, key)).status).toBe(200);
    await api('PATCH', `/admin/projects/${p}`, cookie, { allowedModels: ['some-other-model'] });
    await vi.waitFor(async () => expect((await chat(otherUrl, key)).status).toBe(403), {
      timeout: 5_000,
      interval: 50,
    });
  });
});
