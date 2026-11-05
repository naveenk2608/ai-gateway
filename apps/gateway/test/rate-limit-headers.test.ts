import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/** x-ratelimit-* headers on successful replies (M12), from the limiter's own admission result. */
const models = parseModelsConfig(
  {
    deployments: { quick: { provider: 'mock', mock: { completionTokens: 2 } } },
    models: { 'mock-quick': { deployment: 'quick' } },
  },
  'rate-limit-headers',
);

let gateway: Gateway;
let baseUrl: string;

beforeAll(async () => {
  gateway = createGateway(testConfig({ CACHE_ENABLED: 'true' }), captureLogger().logger, {
    models,
  });
  await gateway.start();
  const { port } = gateway.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gateway.shutdown();
});

interface Limits {
  rpm_limit?: number;
  tpm_limit?: number;
}

/** A fresh key, so every bucket starts full. */
async function keyWith(project: Limits, key: Limits = {}): Promise<string> {
  const projectId = await createProject(gateway.db);
  if (Object.keys(project).length > 0) {
    await gateway.db.updateTable('projects').set(project).where('id', '=', projectId).execute();
  }
  const created = await createApiKey(gateway.db, projectId);
  if (Object.keys(key).length > 0) {
    await gateway.db.updateTable('api_keys').set(key).where('id', '=', created.id).execute();
  }
  return `Bearer ${created.plaintext}`;
}

async function chat(authorization: string, extra: object = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({
      model: 'mock-quick',
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 20,
      ...extra,
    }),
  });
  await res.text();
  const headers = Object.fromEntries(
    [...res.headers].filter(([name]) => name.startsWith('x-ratelimit-')),
  );
  return { status: res.status, headers, cache: res.headers.get('x-gateway-cache') };
}

const DURATION = /^(\d+ms|(\d+h)?(\d+m)?\d+(\.\d+)?s)$/;

describe('x-ratelimit headers', () => {
  it('a successful reply carries all six, from the tightest scope that applies', async () => {
    // Requests: the key's 5 a minute is tighter than the project's 100. Tokens: only the project.
    const auth = await keyWith({ rpm_limit: 100, tpm_limit: 10_000 }, { rpm_limit: 5 });
    const { status, headers } = await chat(auth);
    expect(status).toBe(200);
    expect(headers).toMatchObject({
      'x-ratelimit-limit-requests': '5',
      'x-ratelimit-remaining-requests': '4',
      // One request comes back every 12 s at 5 a minute.
      'x-ratelimit-reset-requests': '12s',
      'x-ratelimit-limit-tokens': '10000',
    });
    // Tokens are counted as reserved: the prompt estimate plus max_tokens (20).
    const remaining = Number(headers['x-ratelimit-remaining-tokens']);
    expect(remaining).toBeLessThanOrEqual(10_000 - 20);
    expect(remaining).toBeGreaterThan(10_000 - 200);
    expect(headers['x-ratelimit-reset-tokens']).toMatch(DURATION);
    expect(Object.keys(headers)).toHaveLength(6);

    const next = await chat(auth);
    expect(next.headers['x-ratelimit-remaining-requests']).toBe('3');
    expect(next.headers['x-ratelimit-reset-requests']).toMatch(DURATION);
  });

  it('streams and cache hits carry them too', async () => {
    // At 5 a minute, one request comes back only every 12 s, so the counts below are exact.
    const auth = await keyWith({ rpm_limit: 5, tpm_limit: 50_000 });
    const stream = await chat(auth, { stream: true });
    expect(stream.status).toBe(200);
    expect(stream.headers['x-ratelimit-remaining-requests']).toBe('4');
    expect(stream.headers['x-ratelimit-limit-tokens']).toBe('50000');

    // A prompt of its own, so no other test's answer is cached.
    const prompt = {
      messages: [{ role: 'user', content: `Cache ${randomBytes(4).toString('hex')}` }],
    };
    await chat(auth, { ...prompt, temperature: 0 });
    const hit = await chat(auth, { ...prompt, temperature: 0 });
    expect(hit.cache).toBe('hit');
    expect(hit.headers['x-ratelimit-remaining-requests']).toBe('2');
    expect(Object.keys(hit.headers)).toHaveLength(6);
  });

  it('a kind with no limit set has no headers', async () => {
    const rpmOnly = await chat(await keyWith({ rpm_limit: 10 }));
    expect(Object.keys(rpmOnly.headers).sort()).toEqual([
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
    ]);
    const none = await chat(await keyWith({}));
    expect(none.status).toBe(200);
    expect(none.headers).toEqual({});
  });
});
