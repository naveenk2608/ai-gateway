import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret } from './api-keys.js';
import { UNLIMITED } from '../limits/policy.js';
import { KeyVerifier, type KeyRecord } from './key-verifier.js';

const pepper = 'pepper-'.repeat(6);
const TTL = 30_000;

function setup(ttlMs = TTL, maxEntries?: number) {
  const clock = new ManualClock();
  const rows = new Map<string, KeyRecord>();
  let loads = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const verifier = new KeyVerifier({
    pepper,
    clock,
    ttlMs,
    maxEntries,
    load: async (keyId) => {
      loads++;
      // Snapshot now, as a database read would, before any hold.
      const row = rows.get(keyId);
      const snapshot = row ? { ...row } : null;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return snapshot;
    },
  });
  const addKey = (overrides: Partial<KeyRecord> = {}) => {
    const key = generateApiKey();
    rows.set(key.keyId, {
      apiKeyId: `id-${key.keyId}`,
      keyId: key.keyId,
      projectId: 'project-1',
      secretHash: hashSecret(key.secret, pepper),
      expiresAt: null,
      revokedAt: null,
      allowedModels: null,
      policy: UNLIMITED,
      ...overrides,
    });
    return key;
  };
  return {
    clock,
    rows,
    verifier,
    addKey,
    loads: () => loads,
    holdLoads: () => (hold = true),
    releaseLoad: () => release?.(),
  };
}

describe('KeyVerifier', () => {
  it('accepts a valid key and reports its project', async () => {
    const t = setup();
    const key = t.addKey({ allowedModels: ['mock-1'] });
    expect(await t.verifier.verify(key.plaintext)).toEqual({
      ok: true,
      key: {
        apiKeyId: `id-${key.keyId}`,
        keyId: key.keyId,
        projectId: 'project-1',
        allowedModels: ['mock-1'],
        policy: UNLIMITED,
      },
    });
  });

  it('rejects malformed, unknown and wrong-secret keys', async () => {
    const t = setup();
    const key = t.addKey();
    expect(await t.verifier.verify('Bearer nope')).toEqual({ ok: false, reason: 'malformed' });
    const unknown = generateApiKey();
    expect(await t.verifier.verify(unknown.plaintext)).toMatchObject({ reason: 'unknown' });
    const forged = `gw_${key.keyId}_${generateApiKey().secret}`;
    expect(await t.verifier.verify(forged)).toMatchObject({ reason: 'secret_mismatch' });
  });

  it('reuses a lookup within the TTL and reloads after it', async () => {
    const t = setup();
    const key = t.addKey();
    await t.verifier.verify(key.plaintext);
    await t.verifier.verify(key.plaintext);
    expect(t.loads()).toBe(1);
    await t.clock.advance(TTL);
    await t.verifier.verify(key.plaintext);
    expect(t.loads()).toBe(2);
  });

  it('rejects a revoked key no later than the TTL, even without an invalidation', async () => {
    const t = setup();
    const key = t.addKey();
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(true);

    t.rows.get(key.keyId)!.revokedAt = t.clock.now();
    await t.clock.advance(TTL - 1);
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(true);
    await t.clock.advance(1);
    expect(await t.verifier.verify(key.plaintext)).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('rejects a revoked key at once after an invalidation', async () => {
    const t = setup();
    const key = t.addKey();
    await t.verifier.verify(key.plaintext);
    t.rows.get(key.keyId)!.revokedAt = t.clock.now();
    t.verifier.invalidateKey(key.keyId);
    expect(await t.verifier.verify(key.plaintext)).toMatchObject({ reason: 'revoked' });
  });

  it('enforces a rotation grace period exactly, from the cached expiry', async () => {
    const t = setup();
    const key = t.addKey({ expiresAt: t.clock.now() + 5_000 });
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(true);
    await t.clock.advance(4_999);
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(true);
    await t.clock.advance(1);
    expect(await t.verifier.verify(key.plaintext)).toMatchObject({ reason: 'expired' });
    expect(t.loads()).toBe(1);
  });

  it('drops every key of a project on a project invalidation', async () => {
    const t = setup();
    const a = t.addKey();
    const b = t.addKey({ projectId: 'project-2' });
    await t.verifier.verify(a.plaintext);
    await t.verifier.verify(b.plaintext);
    t.verifier.invalidateProject('project-1');
    expect(t.verifier.size).toBe(1);
  });

  it('does not cache a lookup that raced with an invalidation', async () => {
    const t = setup();
    const key = t.addKey();
    t.holdLoads();
    const first = t.verifier.verify(key.plaintext);
    // The lookup read the row before the revocation landed...
    t.rows.get(key.keyId)!.revokedAt = t.clock.now();
    t.verifier.invalidateKey(key.keyId);
    t.releaseLoad();
    expect((await first).ok).toBe(true);
    // ...so its stale answer is not kept.
    expect(t.verifier.size).toBe(0);
  });

  it('shares one lookup between concurrent requests for a key', async () => {
    const t = setup();
    const key = t.addKey();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.verifier.verify(key.plaintext)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(t.loads()).toBe(1);
  });

  it('does not cache unknown keys, so a key created elsewhere works at once', async () => {
    const t = setup();
    const key = generateApiKey();
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(false);
    t.rows.set(key.keyId, {
      apiKeyId: 'new',
      keyId: key.keyId,
      projectId: 'project-1',
      secretHash: hashSecret(key.secret, pepper),
      expiresAt: null,
      revokedAt: null,
      allowedModels: null,
      policy: UNLIMITED,
    });
    expect((await t.verifier.verify(key.plaintext)).ok).toBe(true);
  });

  it('evicts the oldest entry when full', async () => {
    const t = setup(TTL, 2);
    const keys = [t.addKey(), t.addKey(), t.addKey()];
    for (const key of keys) await t.verifier.verify(key.plaintext);
    expect(t.verifier.size).toBe(2);
    await t.verifier.verify(keys[0]!.plaintext);
    expect(t.loads()).toBe(4);
  });

  it('with a TTL of 0, looks every key up', async () => {
    const t = setup(0);
    const key = t.addKey();
    await t.verifier.verify(key.plaintext);
    await t.verifier.verify(key.plaintext);
    expect(t.loads()).toBe(2);
  });
});
