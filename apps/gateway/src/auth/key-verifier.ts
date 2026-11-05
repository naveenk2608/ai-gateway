import type { Clock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { UsagePolicy } from '../limits/policy.js';
import { parseApiKey, secretMatches } from './api-keys.js';
import type { UnknownKeyGuard } from './unknown-keys.js';

/** The caller behind a verified API key. */
export interface AuthenticatedKey {
  apiKeyId: string;
  keyId: string;
  projectId: string;
  /** Logical model names the project may call; null allows every configured model. */
  allowedModels: readonly string[] | null;
  /** Rate, token and concurrency limits of the key and project, and the project's budget. */
  policy: UsagePolicy;
}

/** `limited`: the client IP sent too many unknown key IDs, so this one was not looked up. */
export type RejectReason =
  'malformed' | 'unknown' | 'secret_mismatch' | 'revoked' | 'expired' | 'limited';

export type VerifyResult =
  | { ok: true; key: AuthenticatedKey }
  | { ok: false; reason: RejectReason; keyId?: string; retryAfterMs?: number };

/** What the database says about a key: the lookup result the cache holds. */
export interface KeyRecord {
  apiKeyId: string;
  keyId: string;
  projectId: string;
  secretHash: Buffer;
  expiresAt: number | null;
  revokedAt: number | null;
  allowedModels: readonly string[] | null;
  policy: UsagePolicy;
}

export type KeyLoader = (keyId: string) => Promise<KeyRecord | null>;

export interface KeyVerifierOptions {
  load: KeyLoader;
  pepper: string;
  clock: Clock;
  /**
   * How long a lookup is reused. It bounds how stale a decision can be when an invalidation
   * message is lost: a revoked key is rejected at most `ttlMs` after the revocation commits.
   */
  ttlMs: number;
  maxEntries?: number;
  /** Limits lookups of key IDs that do not exist per client IP (M12); absent in unit tests. */
  unknownKeys?: UnknownKeyGuard;
}

interface Entry {
  record: KeyRecord;
  loadedAt: number;
}

/**
 * Verifies API keys with a short-TTL in-process cache, so the request path rarely touches
 * Postgres. The secret is checked against the stored HMAC on every request; only the lookup is
 * cached. Unknown key IDs are not cached in process; with `unknownKeys` they are remembered in
 * Redis for a short while and limited per client IP, and creating a key clears its ID there
 * (`forgetMissing`), so a new key works at once.
 */
export class KeyVerifier {
  readonly #options: KeyVerifierOptions;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<KeyRecord | null>>();
  /** Bumped by every invalidation; a load that started before one is not cached. */
  #epoch = 0;

  constructor(options: KeyVerifierOptions) {
    this.#options = options;
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  /** `client.ip` enables the per-IP limit on unknown key IDs, when `unknownKeys` is set. */
  async verify(presented: string, client?: { ip: string }): Promise<VerifyResult> {
    const parsed = parseApiKey(presented);
    if (!parsed) return { ok: false, reason: 'malformed' };
    const { keyId } = parsed;

    const found = await this.#find(keyId, client);
    if ('retryAfterMs' in found) {
      return { ok: false, reason: 'limited', keyId, retryAfterMs: found.retryAfterMs };
    }
    const record = found.record;
    if (!record) return { ok: false, reason: 'unknown', keyId };
    if (!secretMatches(parsed.secret, this.#options.pepper, record.secretHash)) {
      return { ok: false, reason: 'secret_mismatch', keyId };
    }
    if (record.revokedAt !== null) return { ok: false, reason: 'revoked', keyId };
    if (record.expiresAt !== null && record.expiresAt <= this.#options.clock.now()) {
      return { ok: false, reason: 'expired', keyId };
    }
    return {
      ok: true,
      key: {
        apiKeyId: record.apiKeyId,
        keyId,
        projectId: record.projectId,
        allowedModels: record.allowedModels,
        policy: record.policy,
      },
    };
  }

  /**
   * The key's record from the cache, or from the loader once the unknown-key guard allows it.
   * Returns the guard's wait when the client IP may not look up another key ID now.
   */
  async #find(
    keyId: string,
    client: { ip: string } | undefined,
  ): Promise<{ record: KeyRecord | null } | { retryAfterMs: number }> {
    const guard = this.#options.unknownKeys;
    if (!guard || !client || this.#fresh(keyId)) return { record: await this.#lookup(keyId) };
    const gate = await guard.check(keyId, client.ip);
    if (gate.kind === 'limited') return { retryAfterMs: gate.retryAfterMs };
    if (gate.kind === 'unknown') return { record: null };
    const record = await this.#lookup(keyId);
    if (gate.checked) {
      if (!record) await guard.missed(keyId, client.ip);
      else if (!gate.known) guard.found(keyId);
    }
    return { record };
  }

  /** Clears a key ID remembered as missing, e.g. once a key with that ID was created. */
  async forgetMissing(keyId: string): Promise<void> {
    await this.#options.unknownKeys?.forget(keyId);
  }

  /** Drops one key, e.g. after it was revoked or rotated. */
  invalidateKey(keyId: string): void {
    this.#epoch++;
    this.#cache.delete(keyId);
  }

  /** Drops every key of a project, e.g. after its model allow-list changed. */
  invalidateProject(projectId: string): void {
    this.#epoch++;
    for (const [keyId, entry] of this.#cache) {
      if (entry.record.projectId === projectId) this.#cache.delete(keyId);
    }
  }

  /** Drops everything, e.g. after missing invalidation messages during a Redis reconnect. */
  clear(): void {
    this.#epoch++;
    this.#cache.clear();
  }

  get size(): number {
    return this.#cache.size;
  }

  /** Whether a lookup of `keyId` would be answered from the cache. */
  #fresh(keyId: string): boolean {
    const cached = this.#cache.get(keyId);
    return (
      cached !== undefined && this.#options.clock.now() - cached.loadedAt < this.#options.ttlMs
    );
  }

  #lookup(keyId: string): Promise<KeyRecord | null> {
    const now = this.#options.clock.now();
    const cached = this.#cache.get(keyId);
    if (cached && now - cached.loadedAt < this.#options.ttlMs) {
      return Promise.resolve(cached.record);
    }
    // Concurrent requests for one key share a single database lookup.
    const pending = this.#loading.get(keyId);
    if (pending) return pending;

    const epoch = this.#epoch;
    const load = this.#options
      .load(keyId)
      .then((record) => {
        if (record && epoch === this.#epoch && this.#options.ttlMs > 0) this.#store(record, now);
        else if (!record) this.#cache.delete(keyId);
        return record;
      })
      .finally(() => this.#loading.delete(keyId));
    this.#loading.set(keyId, load);
    return load;
  }

  #store(record: KeyRecord, loadedAt: number): void {
    // Re-inserting moves the key to the end, so the first key is always the oldest entry.
    this.#cache.delete(record.keyId);
    if (this.#cache.size >= this.#maxEntries) {
      const oldest = this.#cache.keys().next();
      if (!oldest.done) this.#cache.delete(oldest.value);
    }
    this.#cache.set(record.keyId, { record, loadedAt });
  }
}

/** Looks a key up with its project's allow-list, limits and budget. */
export function databaseKeyLoader(db: Db): KeyLoader {
  return async (keyId) => {
    const row = await db
      .selectFrom('api_keys')
      .innerJoin('projects', 'projects.id', 'api_keys.project_id')
      .select([
        'api_keys.id',
        'api_keys.project_id',
        'api_keys.secret_hash',
        'api_keys.expires_at',
        'api_keys.revoked_at',
        'api_keys.rpm_limit',
        'api_keys.tpm_limit',
        'api_keys.concurrency_limit',
        'projects.allowed_models',
        'projects.rpm_limit as project_rpm_limit',
        'projects.tpm_limit as project_tpm_limit',
        'projects.concurrency_limit as project_concurrency_limit',
        'projects.monthly_budget_micro_usd',
        'projects.max_request_cost_micro_usd',
        'projects.budget_soft_threshold_pct',
      ])
      .where('api_keys.key_id', '=', keyId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      apiKeyId: row.id,
      keyId,
      projectId: row.project_id,
      secretHash: row.secret_hash,
      expiresAt: row.expires_at?.getTime() ?? null,
      revokedAt: row.revoked_at?.getTime() ?? null,
      allowedModels: row.allowed_models,
      policy: {
        key: { rpm: row.rpm_limit, tpm: row.tpm_limit, concurrency: row.concurrency_limit },
        project: {
          rpm: row.project_rpm_limit,
          tpm: row.project_tpm_limit,
          concurrency: row.project_concurrency_limit,
        },
        monthlyBudgetMicroUsd: row.monthly_budget_micro_usd,
        maxRequestCostMicroUsd: row.max_request_cost_micro_usd,
        budgetSoftThresholdPct: row.budget_soft_threshold_pct,
      },
    };
  };
}
