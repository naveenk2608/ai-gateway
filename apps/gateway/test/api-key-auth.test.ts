import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { systemClock, type Clock } from '@ai-gateway/shared';
import OpenAI, { PermissionDeniedError } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/auth/api-keys.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

const models = parseModelsConfig(
  {
    deployments: { quick: { provider: 'mock', mock: { completionTokens: 3 } } },
    models: { 'mock-a': { deployment: 'quick' }, 'mock-b': { deployment: 'quick' } },
  },
  'auth-test',
);

const running: Gateway[] = [];

async function startGateway(
  overrides: Record<string, string> = {},
  deps: { clock?: Clock; invalidationChannel?: string } = {},
) {
  const gateway = createGateway(testConfig(overrides), captureLogger().logger, {
    models,
    ...deps,
  });
  running.push(gateway);
  await gateway.start();
  const { port } = gateway.app.server.address() as AddressInfo;
  return { gateway, url: `http://127.0.0.1:${port}` };
}

afterAll(async () => {
  await Promise.all(running.map((g) => g.shutdown()));
});

function chat(url: string, key: string | undefined, body: unknown = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({
      model: 'mock-a',
      messages: [{ role: 'user', content: 'hi' }],
      ...(body as object),
    }),
  });
}

describe('API-key authentication on /v1', () => {
  let url: string;
  let gateway: Gateway;

  beforeAll(async () => {
    ({ gateway, url } = await startGateway());
  });

  it('accepts a valid key', async () => {
    const key = await createApiKey(gateway.db, await createProject(gateway.db));
    expect((await chat(url, key.plaintext)).status).toBe(200);
  });

  it('rejects a missing key with an OpenAI-style 401, before validating the body', async () => {
    const res = await chat(url, undefined, { messages: 'not-an-array' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        param: null,
        message: expect.stringMatching(/Missing API key/) as string,
      },
    });
  });

  it.each([
    ['malformed', () => 'sk-not-ours'],
    ['unknown', () => generateApiKey().plaintext],
  ])('rejects a %s key', async (_name, key) => {
    const res = await chat(url, key());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_api_key' } });
  });

  it('rejects a known key ID with the wrong secret', async () => {
    const key = await createApiKey(gateway.db, await createProject(gateway.db));
    const forged = `gw_${key.keyId}_${generateApiKey().secret}`;
    expect((await chat(url, forged)).status).toBe(401);
  });

  it('rejects revoked and expired keys', async () => {
    const projectId = await createProject(gateway.db);
    const revoked = await createApiKey(gateway.db, projectId, { revokedAt: new Date() });
    const expired = await createApiKey(gateway.db, projectId, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    const r1 = await chat(url, revoked.plaintext);
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ error: { message: 'This API key has been revoked.' } });
    const r2 = await chat(url, expired.plaintext);
    expect(r2.status).toBe(401);
    expect(await r2.json()).toMatchObject({ error: { message: 'This API key has expired.' } });
  });

  it('returns 403 with an OpenAI-style error for a model outside the project allow-list', async () => {
    const projectId = await createProject(gateway.db, { allowedModels: ['mock-a'] });
    const key = await createApiKey(gateway.db, projectId);
    expect((await chat(url, key.plaintext, { model: 'mock-a' })).status).toBe(200);

    const res = await chat(url, key.plaintext, { model: 'mock-b' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'model_not_allowed',
        param: 'model',
        message: 'This project is not allowed to use the model `mock-b`.',
      },
    });

    // The OpenAI SDK surfaces it as its permission error.
    const client = new OpenAI({ baseURL: `${url}/v1`, apiKey: key.plaintext, maxRetries: 0 });
    await expect(
      client.chat.completions.create({
        model: 'mock-b',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('revocation and the key cache', () => {
  it('rejects a revoked key within the cache TTL even if no invalidation arrives', async () => {
    const TTL = 30_000;
    // Real time plus an offset the test controls; an isolated channel means no pub/sub reaches it.
    let offset = 0;
    const clock: Clock = {
      now: () => Date.now() + offset,
      sleep: (ms, signal) => systemClock.sleep(ms, signal),
    };
    const { gateway, url } = await startGateway(
      { API_KEY_CACHE_TTL_MS: String(TTL) },
      { clock, invalidationChannel: `test-${randomBytes(4).toString('hex')}` },
    );
    const key = await createApiKey(gateway.db, await createProject(gateway.db));
    expect((await chat(url, key.plaintext)).status).toBe(200); // now cached

    await gateway.db
      .updateTable('api_keys')
      .set({ revoked_at: new Date() })
      .where('id', '=', key.id)
      .execute();

    // Still served from the cache shortly before the TTL...
    offset = TTL - 2_000;
    expect((await chat(url, key.plaintext)).status).toBe(200);
    // ...and rejected once the TTL has passed: the bound.
    offset = TTL;
    expect((await chat(url, key.plaintext)).status).toBe(401);
  });
});

describe('bootstrap from environment settings', () => {
  it('creates the project, owner and key once, and changes nothing on later starts', async () => {
    const email = `owner-${randomBytes(4).toString('hex')}@example.test`;
    const key = generateApiKey();
    const env = {
      BOOTSTRAP_ADMIN_EMAIL: email.toUpperCase(),
      BOOTSTRAP_ADMIN_PASSWORD: 'a-long-enough-password',
      BOOTSTRAP_API_KEY: key.plaintext,
      BOOTSTRAP_PROJECT_NAME: `boot-${randomBytes(3).toString('hex')}`,
    };
    // Two instances starting at once, then a restart.
    const [a, b] = await Promise.all([startGateway(env), startGateway(env)]);
    await startGateway(env);

    expect((await chat(a.url, key.plaintext)).status).toBe(200);
    expect((await chat(b.url, key.plaintext)).status).toBe(200);

    const db = a.gateway.db;
    const user = await db
      .selectFrom('users')
      .select(['id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const memberships = await db
      .selectFrom('project_members')
      .innerJoin('projects', 'projects.id', 'project_members.project_id')
      .select(['projects.id', 'projects.name', 'project_members.role'])
      .where('user_id', '=', user.id)
      .execute();
    expect(memberships).toEqual([
      { id: expect.any(String) as string, name: env.BOOTSTRAP_PROJECT_NAME, role: 'owner' },
    ]);
    const keys = await db
      .selectFrom('api_keys')
      .select('project_id')
      .where('key_id', '=', key.keyId)
      .execute();
    expect(keys).toEqual([{ project_id: memberships[0]!.id }]);
    const audits = await db
      .selectFrom('audit_logs')
      .select(['action', 'actor_type'])
      .where('project_id', '=', memberships[0]!.id)
      .orderBy('id')
      .execute();
    expect(audits).toEqual([
      { action: 'project.create', actor_type: 'system' },
      { action: 'member.add', actor_type: 'system' },
      { action: 'api_key.create', actor_type: 'system' },
    ]);

    // A changed password setting does not overwrite the stored one.
    await startGateway({ ...env, BOOTSTRAP_ADMIN_PASSWORD: 'a-different-password' });
    const after = await db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(after.password_hash).toBe(user.password_hash);
  });
});
