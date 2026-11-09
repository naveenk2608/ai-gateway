import { createHash } from 'node:crypto';
import { uuidv7, type Clock } from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';
import { GatewayError } from '../errors.js';
import { Flight } from './coalesce.js';

/**
 * Idempotency-Key (M15, ADR 032), following the IETF draft "The Idempotency-Key HTTP Header Field"
 * (draft-ietf-httpapi-idempotency-key-header-08, 2026-10-22): the field is a Structured Field Item
 * whose value is a String (RFC 9651, section 3.3.3), so it is sent quoted.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Marks a replayed answer; the draft names no header, so Stripe's documented one. */
export const REPLAYED_HEADER = 'idempotent-replayed';
/** Stripe's documented key length limit (docs.stripe.com/api/idempotent_requests, 2026-11-09). */
export const MAX_KEY_LENGTH = 255;

export type IdempotentEndpoint = 'chat' | 'embeddings';

const invalidKey = (why: string) =>
  new GatewayError(
    'invalid_idempotency_key',
    `The Idempotency-Key header ${why}. Send one quoted string of 1 to ${MAX_KEY_LENGTH} ` +
      'printable ASCII characters, e.g. Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324".',
    { httpStatus: 400 },
  );

/**
 * The key from an Idempotency-Key header, parsed as an RFC 9651 String (section 4.2.5): a double
 * quote, printable ASCII (%x20-7E) in which only `\"` and `\\` are escapes, a closing quote, and
 * nothing after it (no parameters). Undefined when the header is absent; a 400 when malformed,
 * empty or longer than 255 characters. Repeated header lines arrive joined by commas, which fails.
 */
export function parseIdempotencyKey(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw invalidKey('appears more than once');
  const field = value.replace(/^ +| +$/g, '');
  if (field[0] !== '"') throw invalidKey('is not a quoted string');
  let key = '';
  let i = 1;
  for (;;) {
    if (i >= field.length) throw invalidKey('has no closing quote');
    const c = field[i++]!;
    if (c === '\\') {
      const next = field[i++];
      if (next !== '"' && next !== '\\') throw invalidKey('escapes a character other than " or \\');
      key += next;
    } else if (c === '"') {
      break;
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e)
        throw invalidKey('holds a character that is not printable ASCII');
      key += c;
    }
  }
  if (i !== field.length) throw invalidKey('has something after the quoted string');
  if (key.length === 0) throw invalidKey('is empty');
  if (key.length > MAX_KEY_LENGTH) throw invalidKey(`is longer than ${MAX_KEY_LENGTH} characters`);
  return key;
}

/** JSON with object keys sorted at every level, so equal bodies give equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The request's fingerprint (the draft's section 2.4): SHA-256 over the validated body without
 * `stream`, `stream_options` and `user`, which do not change the answer (as the cache key leaves
 * them out), with keys sorted. The same key with another fingerprint is refused with 422.
 */
export function requestFingerprint(body: object): string {
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of ['stream', 'stream_options', 'user']) delete rest[field];
  return createHash('sha256').update(stableJson(rest)).digest('hex');
}

/** What a replay needs: the first answer's status, the headers it repeats, and the answer. */
export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  /** The answer in the handler's own form; null when it was larger than the cap (not kept). */
  body: unknown;
}

export interface IdempotencySettings {
  /** Off: the header is ignored (IDEMPOTENCY_ENABLED). */
  enabled: boolean;
  /** How long a key is kept from its first use (IDEMPOTENCY_KEY_TTL_HOURS; Stripe: 24 h). */
  ttlMs: number;
  /** How long a running request holds its key before another may take it over (IDEMPOTENCY_LOCK_MS). */
  lockMs: number;
  /** Larger answers are not kept (IDEMPOTENCY_MAX_BODY_BYTES); a repeat then gets 409. */
  maxBodyBytes: number;
}

export interface IdempotencyDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** This gateway instance, written as the lock's owner. */
  instanceId: string;
}

export type Claim =
  /** The first request with the key: it runs, then completes or fails the lead. */
  | { kind: 'lead'; lead: IdempotentLead }
  /** A completed key: answer with the stored answer. */
  | { kind: 'replay'; stored: StoredResponse }
  /** The first request runs on this instance: wait for it (within the repeat's deadline). */
  | { kind: 'wait'; flight: Flight<StoredResponse> }
  /** The first request runs on another instance (or its wait cannot be joined): 409. */
  | { kind: 'busy'; retryAfterSeconds: number }
  /** The key was used with another request body: 422. */
  | { kind: 'mismatch' };

export function keyReused(): GatewayError {
  return new GatewayError(
    'idempotency_key_reused',
    'This Idempotency-Key was already used with a different request body. Use a new key for a ' +
      'different request.',
    { httpStatus: 422 },
  );
}

export function keyInProgress(retryAfterSeconds: number): GatewayError {
  return new GatewayError(
    'idempotency_key_in_progress',
    'A request with this Idempotency-Key is still running. Retry with the same key and body ' +
      'after the Retry-After delay.',
    { httpStatus: 409, retryable: true, retryAfterSeconds },
  );
}

export function answerNotStored(): GatewayError {
  return new GatewayError(
    'idempotency_answer_not_stored',
    'The request with this Idempotency-Key completed, but its answer was too large to keep, so it ' +
      'cannot be replayed and was not run again. Use a new key to run it again.',
    { httpStatus: 409 },
  );
}

export function idempotencyUnavailable(): GatewayError {
  return new GatewayError(
    'idempotency_unavailable',
    'Requests with an Idempotency-Key cannot be checked right now; retry shortly.',
    { httpStatus: 503, retryable: true, retryAfterSeconds: 1 },
  );
}

/**
 * Keys and their stored answers in Postgres (ADR 032). The unique (project, endpoint, key)
 * constraint makes the first insert the only lead across instances. Requests waiting for a lead
 * on this instance follow its `Flight` (the coalescing code, ADR 031).
 */
export class IdempotencyGate {
  readonly settings: IdempotencySettings;
  readonly #deps: IdempotencyDeps;
  readonly #flights = new Map<string, Flight<StoredResponse>>();

  constructor(settings: IdempotencySettings, deps: IdempotencyDeps) {
    this.settings = settings;
    this.#deps = deps;
  }

  /**
   * Claims `key` for this request, or says how to answer it. Throws when Postgres fails (the
   * caller answers 503: running the request unchecked could charge it twice).
   */
  async claim(c: {
    projectId: string;
    endpoint: IdempotentEndpoint;
    key: string;
    fingerprint: string;
    requestId: string;
    /** REQUEST_DEADLINE_MS, for the Retry-After of a 409. */
    deadlineMs?: number | undefined;
  }): Promise<Claim> {
    const { db, clock, instanceId } = this.#deps;
    const local = `${c.projectId}\u0000${c.endpoint}\u0000${c.key}`;
    const scope = () =>
      db
        .selectFrom('idempotency_keys')
        .where('project_id', '=', c.projectId)
        .where('endpoint', '=', c.endpoint)
        .where('idempotency_key', '=', c.key);
    // A row can vanish between the insert and the read (released, or expired and deleted): try
    // again a few times.
    for (let round = 0; round < 3; round++) {
      const now = clock.now();
      const inserted = await db
        .insertInto('idempotency_keys')
        .values({
          id: uuidv7(now),
          project_id: c.projectId,
          endpoint: c.endpoint,
          idempotency_key: c.key,
          fingerprint: c.fingerprint,
          status: 'in_progress',
          request_id: c.requestId,
          owner: instanceId,
          locked_until: new Date(now + this.settings.lockMs),
          expires_at: new Date(now + this.settings.ttlMs),
        })
        .onConflict((oc) => oc.constraint('idempotency_keys_scope').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted) return { kind: 'lead', lead: this.#lead(local, inserted.id, c.requestId) };

      const row = await scope()
        .select([
          'id',
          'fingerprint',
          'status',
          'owner',
          'locked_until',
          'expires_at',
          'created_at',
          'response_status',
          'response_headers',
          'response',
        ])
        .executeTakeFirst();
      if (!row) continue;
      if (row.expires_at.getTime() <= now) {
        // Expired but not yet deleted by the worker: it no longer exists for clients.
        await db
          .deleteFrom('idempotency_keys')
          .where('id', '=', row.id)
          .where('expires_at', '<=', new Date(now))
          .execute();
        continue;
      }
      if (row.fingerprint !== c.fingerprint) return { kind: 'mismatch' };
      if (row.status === 'completed') {
        return {
          kind: 'replay',
          stored: {
            status: row.response_status ?? 200,
            headers: (row.response_headers ?? {}) as Record<string, string>,
            body: row.response ?? null,
          },
        };
      }
      if (row.locked_until.getTime() <= now) {
        // Its holder never finished (a crashed instance): take the key over.
        const taken = await db
          .updateTable('idempotency_keys')
          .set({
            owner: instanceId,
            request_id: c.requestId,
            locked_until: new Date(now + this.settings.lockMs),
          })
          .where('id', '=', row.id)
          .where('status', '=', 'in_progress')
          .where('locked_until', '<=', new Date(now))
          .returning('id')
          .executeTakeFirst();
        if (taken) return { kind: 'lead', lead: this.#lead(local, row.id, c.requestId) };
        continue;
      }
      const flight = row.owner === instanceId ? this.#flights.get(local) : undefined;
      if (flight && !flight.settled) return { kind: 'wait', flight };
      const untilDeadline =
        c.deadlineMs === undefined ? 0 : row.created_at.getTime() + c.deadlineMs - now;
      return { kind: 'busy', retryAfterSeconds: Math.max(1, Math.ceil(untilDeadline / 1000)) };
    }
    return { kind: 'busy', retryAfterSeconds: 1 };
  }

  #lead(local: string, id: string, requestId: string): IdempotentLead {
    const flight: Flight<StoredResponse> = new Flight<StoredResponse>(() => {
      if (this.#flights.get(local) === flight) this.#flights.delete(local);
    });
    this.#flights.set(local, flight);
    return new IdempotentLead(this.settings, this.#deps, id, requestId, flight);
  }
}

/**
 * The request that holds a key: it completes the key with its answer, or fails it (the key is
 * deleted, so the client may retry). Either settles the flight that repeats on this instance wait
 * on. Neither throws.
 */
export class IdempotentLead {
  readonly flight: Flight<StoredResponse>;
  readonly #settings: IdempotencySettings;
  readonly #deps: IdempotencyDeps;
  readonly #id: string;
  readonly #requestId: string;
  #done = false;

  constructor(
    settings: IdempotencySettings,
    deps: IdempotencyDeps,
    id: string,
    requestId: string,
    flight: Flight<StoredResponse>,
  ) {
    this.#settings = settings;
    this.#deps = deps;
    this.#id = id;
    this.#requestId = requestId;
    this.flight = flight;
  }

  /** Whether it was completed or failed already. */
  get done(): boolean {
    return this.#done;
  }

  /** Stores a 2xx answer (its body only up to the cap) and hands it to waiting repeats. */
  async complete(response: StoredResponse): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    const json = JSON.stringify(response.body);
    const bytes = Buffer.byteLength(json);
    const kept = bytes <= this.#settings.maxBodyBytes;
    const stored: StoredResponse = kept ? response : { ...response, body: null };
    try {
      await this.#deps.db
        .updateTable('idempotency_keys')
        .set({
          status: 'completed',
          response_status: response.status,
          response_headers: JSON.stringify(response.headers),
          response: kept ? json : null,
          response_bytes: bytes,
          completed_at: new Date(this.#deps.clock.now()),
        })
        .where('id', '=', this.#id)
        .where('request_id', '=', this.#requestId)
        .execute();
    } catch (err) {
      // The key stays in progress until its lock ends; a repeat until then gets 409.
      this.#deps.logger.warn({ err }, 'idempotency key could not be completed');
    }
    this.flight.resolve(stored);
  }

  /** Releases the key after a failure (the client may retry with it), and fails waiting repeats. */
  async fail(error: unknown): Promise<void> {
    if (this.#done) return;
    this.#done = true;
    try {
      await this.#deps.db
        .deleteFrom('idempotency_keys')
        .where('id', '=', this.#id)
        .where('request_id', '=', this.#requestId)
        .where('status', '=', 'in_progress')
        .execute();
    } catch (err) {
      // The key stays until its lock ends, then the next request with it takes it over.
      this.#deps.logger.warn({ err }, 'idempotency key could not be released');
    }
    this.flight.reject(error);
  }
}
