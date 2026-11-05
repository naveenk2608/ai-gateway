import type { Clock } from '@ai-gateway/shared';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import { UNKNOWN_KEY_CHECK, UNKNOWN_KEY_MISS } from '../limits/scripts.js';

/**
 * How long a key ID found in the database is remembered as existing. Lookups of such key IDs are
 * never limited, so a valid key is not refused because other clients behind the same address (a
 * proxy, a NAT) sent unknown ones.
 */
export const KNOWN_KEY_TTL_MS = 3_600_000;

/** What to do before an API key's database lookup. */
export type UnknownKeyGate =
  | {
      kind: 'lookup';
      /** The key ID is known to exist. */
      known: boolean;
      /** False when Redis did not answer: the lookup goes ahead unchecked, as before M12. */
      checked: boolean;
    }
  /** The key ID is known not to exist: reject it without a lookup. */
  | { kind: 'unknown' }
  /** The client IP sent too many unknown key IDs: refuse it before any lookup. */
  | { kind: 'limited'; retryAfterMs: number };

export interface UnknownKeyGuardOptions {
  redis: Redis;
  clock: Clock;
  logger: Logger;
  /** Unknown key IDs one client IP may send per minute (a token bucket). */
  perMinutePerIp: number;
  /** How long a key ID the database does not have is remembered. */
  cacheMs: number;
  /** Key prefix; tests use their own. */
  prefix?: string;
  /** Counts each rejected (401) or limited (429) request. */
  onResult?: (result: 'rejected' | 'limited') => void;
}

/**
 * Keeps requests with API key IDs that do not exist from costing a Postgres lookup each (M12).
 * Each key ID has a marker in Redis: `1` once the database had it, `0` for a while after it did
 * not. A key ID not known to exist may only be looked up while the client IP's unknown-key bucket
 * has a token; each miss, and each key ID already known to be missing, takes one. Checks run in one
 * Lua script, so they hold across gateway instances (ADR 008). When Redis does not answer, the
 * lookup goes ahead unchecked: the key itself is still verified against Postgres.
 */
export class UnknownKeyGuard {
  readonly #o: UnknownKeyGuardOptions;
  readonly #prefix: string;

  constructor(options: UnknownKeyGuardOptions) {
    this.#o = options;
    this.#prefix = options.prefix ?? 'gw:';
  }

  #bucket(ip: string): string {
    return `${this.#prefix}rl:unknown-key:ip:${ip}`;
  }

  #marker(keyId: string): string {
    return `${this.#prefix}auth:key:${keyId}`;
  }

  /** Before a database lookup of `keyId` for a request from `ip`. */
  async check(keyId: string, ip: string): Promise<UnknownKeyGate> {
    let reply: unknown[];
    try {
      reply = (await UNKNOWN_KEY_CHECK.run(
        this.#o.redis,
        [this.#bucket(ip), this.#marker(keyId)],
        [this.#o.clock.now(), this.#o.perMinutePerIp],
      )) as unknown[];
    } catch (err) {
      this.#o.logger.warn({ err }, 'unknown API key check unavailable; looking the key up');
      return { kind: 'lookup', known: false, checked: false };
    }
    switch (Number(reply[0])) {
      case 3:
        return { kind: 'lookup', known: true, checked: true };
      case 2:
        return { kind: 'lookup', known: false, checked: true };
      case 1:
        this.#o.onResult?.('rejected');
        return { kind: 'unknown' };
      default:
        this.#o.onResult?.('limited');
        this.#o.logger.warn({ ip }, 'too many unknown API keys from one client IP');
        return { kind: 'limited', retryAfterMs: Number(reply[1]) };
    }
  }

  /** The database has no such key ID: remember it, and count it against the client IP. */
  async missed(keyId: string, ip: string): Promise<void> {
    this.#o.onResult?.('rejected');
    try {
      await UNKNOWN_KEY_MISS.run(
        this.#o.redis,
        [this.#bucket(ip), this.#marker(keyId)],
        [this.#o.clock.now(), this.#o.perMinutePerIp, this.#o.cacheMs],
      );
    } catch (err) {
      this.#o.logger.warn({ err }, 'could not record an unknown API key');
    }
  }

  /** The database has the key ID: later lookups of it skip the IP limit. Best effort. */
  found(keyId: string): void {
    void this.#o.redis
      .set(this.#marker(keyId), '1', 'PX', KNOWN_KEY_TTL_MS)
      .catch((err: unknown) => this.#o.logger.warn({ err }, 'could not record a known API key'));
  }

  /** Drops what is remembered about `keyId`, e.g. once a key with that ID was created. */
  async forget(keyId: string): Promise<void> {
    try {
      await this.#o.redis.del(this.#marker(keyId));
    } catch (err) {
      this.#o.logger.warn({ err }, 'could not clear a cached unknown API key');
    }
  }
}
