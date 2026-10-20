import { describe, expect, it } from 'vitest';
import { generateApiKey, hashSecret, maskedKey, parseApiKey, secretMatches } from './api-keys.js';

const pepper = 'p'.repeat(32);

describe('API keys', () => {
  it('generates keys in the gw_<keyId>_<secret> format that parse back', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^gw_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(parseApiKey(key.plaintext)).toEqual({ keyId: key.keyId, secret: key.secret });
  });

  it('never generates the same key twice', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => generateApiKey().keyId));
    expect(ids.size).toBe(1_000);
  });

  it.each([
    '',
    'sk-abc',
    'gw_0123456789abcdef',
    `gw_0123456789ABCDEF_${'a'.repeat(64)}`,
    `gw_0123456789abcdef_${'a'.repeat(63)}`,
    `gw_0123456789abcdef_${'a'.repeat(64)} `,
    `xgw_0123456789abcdef_${'a'.repeat(64)}`,
  ])('rejects malformed key %j', (value) => {
    expect(parseApiKey(value)).toBeNull();
  });

  it('matches a secret only against its own HMAC under the same pepper', () => {
    const { secret } = generateApiKey();
    const stored = hashSecret(secret, pepper);
    expect(stored).toHaveLength(32);
    expect(secretMatches(secret, pepper, stored)).toBe(true);
    expect(secretMatches(generateApiKey().secret, pepper, stored)).toBe(false);
    expect(secretMatches(secret, 'q'.repeat(32), stored)).toBe(false);
  });

  it('masks keys for display', () => {
    expect(maskedKey('0123456789abcdef')).toBe('gw_0123456789abcdef_…');
  });
});
