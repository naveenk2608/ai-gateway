import { describe, expect, it } from 'vitest';
import { hashPassword, verifyDecoyPassword, verifyPassword } from './passwords.js';

describe('passwords', () => {
  it('hashes with argon2id and verifies only the right password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'correct horse battery stapler')).toBe(false);
  });

  it('salts each hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('treats a malformed stored hash as a mismatch', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('decoy checks never succeed', async () => {
    expect(await verifyDecoyPassword('anything')).toBe(false);
  });
});
