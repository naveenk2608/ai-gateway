import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Admin passwords (ADR 007): argon2id (the library default) with OWASP's minimum parameters,
 * 19 MiB of memory and 2 passes, which keeps a login under ~100 ms on a small instance.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
/** Bounds hashing work per request. */
export const PASSWORD_MAX_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed stored hash never matches.
    return false;
  }
}

let decoy: Promise<string> | undefined;

/**
 * Spends the same work as a real check, for logins with an unknown email, so response time does
 * not reveal which emails have accounts.
 */
export async function verifyDecoyPassword(password: string): Promise<false> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await decoy, password);
  return false;
}
