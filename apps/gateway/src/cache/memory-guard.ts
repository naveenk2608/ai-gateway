import type { Clock } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';

/** What `INFO memory` reports: `used_memory` and `maxmemory`, in bytes (0 means no limit). */
export interface MemoryReading {
  usedBytes: number;
  maxBytes: number;
}

export interface MemoryGuardSettings {
  /** Off: every store is allowed, as before M15 (CACHE_MEMORY_GUARD_ENABLED). */
  enabled: boolean;
  /** How long a reading is reused before INFO is asked again (CACHE_MEMORY_CHECK_INTERVAL_MS). */
  intervalMs: number;
  /** Stores stop once used memory reaches this share of `maxmemory` (CACHE_MAX_MEMORY_SHARE). */
  maxShare: number;
  /** The cap in bytes when `maxmemory` is 0, i.e. unlimited (CACHE_MAX_MEMORY_BYTES). */
  maxBytesWhenUnlimited: number;
}

export interface MemoryGuardDeps {
  /** Sends `INFO memory` and returns the raw reply. */
  info: () => Promise<string>;
  clock: Clock;
  logger: Logger;
  /** The last reading and the cap it was compared with, for the gauge. */
  onReading?: (reading: MemoryReading, capBytes: number) => void;
}

/** Why a store was skipped: memory at or above the cap, or no reading (INFO failed). */
export type SkipReason = 'memory_cap' | 'memory_unknown';

export type Verdict = { ok: true } | { ok: false; reason: SkipReason };

/** Reads `used_memory` and `maxmemory` from an `INFO memory` reply; null if either is missing. */
export function parseMemoryInfo(reply: string): MemoryReading | null {
  const fields = new Map<string, string>();
  for (const line of reply.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const used = Number(fields.get('used_memory'));
  const max = Number(fields.get('maxmemory'));
  if (!fields.has('used_memory') || !fields.has('maxmemory')) return null;
  if (!Number.isFinite(used) || !Number.isFinite(max) || used < 0 || max < 0) return null;
  return { usedBytes: used, maxBytes: max };
}

/**
 * Lets the response cache store only while Redis has room (M15): a free Redis with `noeviction`
 * refuses writes once full, and the gateway fails closed when Redis fails (ADR 010), so the cache
 * must never be what fills it. Before a store it reads `INFO memory`, at most once per
 * `intervalMs` (callers in between share the last reading), and allows the store while
 * `used_memory` is below `maxShare x maxmemory`, or below `maxBytesWhenUnlimited` when `maxmemory`
 * is 0. When INFO fails or is not allowed, nothing is stored and that is logged once (until a
 * reading works again).
 */
export class MemoryGuard {
  readonly settings: MemoryGuardSettings;
  readonly #deps: MemoryGuardDeps;
  #last: { at: number; reading: MemoryReading | null } | undefined;
  #pending: Promise<MemoryReading | null> | undefined;
  #failureLogged = false;

  constructor(settings: MemoryGuardSettings, deps: MemoryGuardDeps) {
    this.settings = settings;
    this.#deps = deps;
  }

  /** The cap in bytes for a reading. */
  capOf(reading: MemoryReading): number {
    return reading.maxBytes > 0
      ? Math.floor(reading.maxBytes * this.settings.maxShare)
      : this.settings.maxBytesWhenUnlimited;
  }

  /** Whether a store may go ahead now. Never throws. */
  async check(): Promise<Verdict> {
    if (!this.settings.enabled) return { ok: true };
    const reading = await this.#reading();
    if (reading === null) return { ok: false, reason: 'memory_unknown' };
    return reading.usedBytes < this.capOf(reading)
      ? { ok: true }
      : { ok: false, reason: 'memory_cap' };
  }

  async #reading(): Promise<MemoryReading | null> {
    const now = this.#deps.clock.now();
    if (this.#last && now - this.#last.at < this.settings.intervalMs) return this.#last.reading;
    this.#pending ??= this.#read().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #read(): Promise<MemoryReading | null> {
    let reading: MemoryReading | null = null;
    let err: unknown;
    try {
      reading = parseMemoryInfo(await this.#deps.info());
    } catch (e) {
      err = e;
    }
    this.#last = { at: this.#deps.clock.now(), reading };
    if (reading === null) {
      if (!this.#failureLogged) {
        this.#failureLogged = true;
        this.#deps.logger.warn(
          {
            err,
            reason: err === undefined ? 'no used_memory or maxmemory in the reply' : 'INFO failed',
          },
          'response cache stores paused: Redis memory use is unknown',
        );
      }
      return null;
    }
    if (this.#failureLogged) {
      this.#failureLogged = false;
      this.#deps.logger.info('response cache stores resumed: Redis memory use is known again');
    }
    this.#deps.onReading?.(reading, this.capOf(reading));
    return reading;
  }
}
