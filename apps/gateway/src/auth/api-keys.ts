import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys (ADR 006): `gw_<keyId>_<secret>`. The key ID is public and used for lookup; only
 * HMAC-SHA256(secret, pepper) is stored, so a database leak alone reveals no usable key. Both
 * parts are lowercase hex, so the key has no ambiguous characters and splits unambiguously.
 */
export const API_KEY_PATTERN = /^gw_([0-9a-f]{16})_([0-9a-f]{64})$/;

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

export interface NewApiKey extends ParsedApiKey {
  /** The full key. Returned to the caller once and never stored or logged. */
  plaintext: string;
}

export function generateApiKey(): NewApiKey {
  const keyId = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('hex');
  return { keyId, secret, plaintext: `gw_${keyId}_${secret}` };
}

export function parseApiKey(value: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(value);
  if (!match) return null;
  return { keyId: match[1]!, secret: match[2]! };
}

export function hashSecret(secret: string, pepper: string): Buffer {
  return createHmac('sha256', pepper).update(secret).digest();
}

/** Constant-time comparison of a presented secret against the stored hash. */
export function secretMatches(secret: string, pepper: string, storedHash: Buffer): boolean {
  const presented = hashSecret(secret, pepper);
  return presented.length === storedHash.length && timingSafeEqual(presented, storedHash);
}

/** How a key is shown after creation: enough to recognise it, nothing usable. */
export function maskedKey(keyId: string): string {
  return `gw_${keyId}_…`;
}
