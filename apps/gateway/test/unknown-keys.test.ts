import type { AddressInfo } from 'node:net';
import { ManualClock, uuidv7 } from '@ai-gateway/shared';
import { closeRedis, createRedis } from '@ai-gateway/shared/node';
import { afterAll, describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret } from '../src/auth/api-keys.js';
import { KeyVerifier, type KeyRecord, type VerifyResult } from '../src/auth/key-verifier.js';
import { UnknownKeyGuard } from '../src/auth/unknown-keys.js';
import { createGateway } from '../src/gateway.js';
import { UNLIMITED } from '../src/limits/policy.js';
import { captureLogger, noModels, testConfig } from './helpers.js';

/** Unknown API key IDs limited per client IP before any database lookup (M12), on real Redis. */
const pepper = 'pepper-'.repeat(6);
const { logger } = captureLogger();
const redis = createRedis(process.env.REDIS_URL!, logger);
const dead = createRedis('redis://127.0.0.1:1', logger);

afterAll(async () => {
  await closeRedis(redis);
  dead.disconnect();
});

/** Documentation addresses (RFC 5737), unique per call so runs never share a bucket. */
let nextIp = 0;
const ip = () => `198.51.100.${(nextIp++ % 250) + 1}`;

function setup({ perMinute = 5, ttlMs = 30_000, guardRedis = redis } = {}) {
  const clock = new ManualClock(Date.now());
  const rows = new Map<string, KeyRecord>();
  const results: string[] = [];
  let loads = 0;
  const guard = new UnknownKeyGuard({
    redis: guardRedis,
    clock,
    logger,
    perMinutePerIp: perMinute,
    cacheMs: 60_000,
    // Each test's markers and buckets are its own.
    prefix: `test:${uuidv7()}:`,
    onResult: (result) => results.push(result),
  });
  const verifier = new KeyVerifier({
    pepper,
    clock,
    ttlMs,
    unknownKeys: guard,
    load: (keyId) => {
      loads++;
      return Promise.resolve(rows.get(keyId) ?? null);
    },
  });
  const addKey = (key = generateApiKey()) => {
    rows.set(key.keyId, {
      apiKeyId: `id-${key.keyId}`,
      keyId: key.keyId,
      projectId: 'project-1',
      secretHash: hashSecret(key.secret, pepper),
      expiresAt: null,
      revokedAt: null,
      allowedModels: null,
      policy: UNLIMITED,
    });
    return key;
  };
  return { verifier, addKey, results, loads: () => loads };
}

const reason = (result: VerifyResult) => (result.ok ? 'ok' : result.reason);

describe('unknown API key IDs', () => {
  it('a flood from one IP is refused after the limit, without a database lookup each', async () => {
    const t = setup({ perMinute: 5 });
    const flooder = ip();
    const outcomes: VerifyResult[] = [];
    for (let i = 0; i < 50; i++) {
      outcomes.push(await t.verifier.verify(generateApiKey().plaintext, { ip: flooder }));
    }
    expect(outcomes.slice(0, 5).map(reason)).toEqual(Array(5).fill('unknown'));
    expect(outcomes.slice(5).map(reason)).toEqual(Array(45).fill('limited'));
    expect(t.loads()).toBe(5);
    const limited = outcomes.at(-1)!;
    expect(!limited.ok && limited.retryAfterMs).toBeGreaterThan(0);
    expect(t.results.filter((r) => r === 'limited')).toHaveLength(45);

    // Another address still gets its keys looked up.
    expect(reason(await t.verifier.verify(generateApiKey().plaintext, { ip: ip() }))).toBe(
      'unknown',
    );
    expect(t.loads()).toBe(6);
  });

  it('a key ID known to be missing is refused again without a lookup', async () => {
    const t = setup({ perMinute: 100 });
    const key = generateApiKey();
    const from = ip();
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('unknown');
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('unknown');
    expect(t.loads()).toBe(1);
    expect(t.results).toEqual(['rejected', 'rejected']);
  });

  it('a key created after its ID was tried works at once when its ID is cleared', async () => {
    const t = setup({ perMinute: 100 });
    const key = generateApiKey();
    const from = ip();
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('unknown');
    t.addKey(key);
    // Still remembered as missing until the creation clears it (the admin route publishes it).
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('unknown');
    await t.verifier.forgetMissing(key.keyId);
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('ok');
  });

  it('a key seen in the database is never limited, even from an address that sent too many unknown ones', async () => {
    // No in-process cache, so every request needs a lookup.
    const t = setup({ perMinute: 2, ttlMs: 0 });
    const shared = ip();
    const seen = t.addKey();
    expect(reason(await t.verifier.verify(seen.plaintext, { ip: shared }))).toBe('ok');
    for (let i = 0; i < 5; i++) await t.verifier.verify(generateApiKey().plaintext, { ip: shared });
    expect(reason(await t.verifier.verify(generateApiKey().plaintext, { ip: shared }))).toBe(
      'limited',
    );

    expect(reason(await t.verifier.verify(seen.plaintext, { ip: shared }))).toBe('ok');
    // A key never looked up before waits like an unknown one from that address, not from others.
    const fresh = t.addKey();
    expect(reason(await t.verifier.verify(fresh.plaintext, { ip: shared }))).toBe('limited');
    expect(reason(await t.verifier.verify(fresh.plaintext, { ip: ip() }))).toBe('ok');
  });

  it('when Redis does not answer, keys are looked up and verified as before', async () => {
    const t = setup({ perMinute: 1, guardRedis: dead });
    const key = t.addKey();
    const from = ip();
    for (let i = 0; i < 3; i++) {
      expect(reason(await t.verifier.verify(generateApiKey().plaintext, { ip: from }))).toBe(
        'unknown',
      );
    }
    expect(reason(await t.verifier.verify(key.plaintext, { ip: from }))).toBe('ok');
    expect(t.loads()).toBe(4);
  });
});

describe('unknown API key IDs over HTTP', () => {
  it('answers a flood from one client IP with 429 and retry-after once the limit is used', async () => {
    const gateway = createGateway(
      testConfig({ UNKNOWN_KEYS_PER_MINUTE_PER_IP: '3', TRUST_PROXY: '1' }),
      captureLogger().logger,
      { models: noModels },
    );
    await gateway.start();
    try {
      const { port } = gateway.app.server.address() as AddressInfo;
      // The proxy in front (trusted, TRUST_PROXY=1) names the client: a documentation address.
      const client = `2001:db8::${uuidv7().slice(-12, -8)}:${uuidv7().slice(-4)}`;
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 6; i++) {
        last = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: {
            authorization: `Bearer ${generateApiKey().plaintext}`,
            'x-forwarded-for': client,
          },
        });
        statuses.push(last.status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
      expect(Number(last!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await last!.json()).toMatchObject({
        error: { type: 'rate_limit_error', code: 'too_many_invalid_api_keys' },
      });
    } finally {
      await gateway.shutdown();
    }
  });
});
