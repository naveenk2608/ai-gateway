import type { Clock } from '@ai-gateway/shared';
import { openText, type Db, type Logger } from '@ai-gateway/shared/node';
import { sql } from 'kysely';
import { renderDelivery, type AlertPayload } from './format.js';
import { systemResolver, vetTarget, type Resolver } from './ssrf.js';
import { httpsTransport, type Transport } from './transport.js';

/**
 * Waits before retry n (after failed attempt n), from the Standard Webhooks spec's recommended
 * schedule (github.com/standard-webhooks/standard-webhooks, spec/standard-webhooks.md, checked
 * 2026-11-09): 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h.
 */
export const RETRY_DELAYS_MS = [
  5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 50_400_000, 72_000_000, 86_400_000,
];

export interface AlertSettings {
  /** Off: nothing is sent (ALERTS_ENABLED). */
  enabled: boolean;
  /** How often due deliveries are looked for (ALERTS_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  /** Attempts before a delivery is marked failed (ALERTS_MAX_ATTEMPTS, at most 10). */
  maxAttempts: number;
  /** The most one send may take (ALERTS_SEND_TIMEOUT_MS). */
  sendTimeoutMs: number;
  /** Delivered and failed rows older than this are deleted (ALERTS_DELIVERY_RETENTION_DAYS). */
  retentionDays: number;
}

export interface DispatcherDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** A number in [0, 1), for the jitter. */
  random: () => number;
  /** The AES key for URLs and secrets; null when neither key setting is set (nothing is sent). */
  key: Buffer | null;
  resolve?: Resolver;
  transport?: Transport;
}

const BATCH = 20;
const HOUR_MS = 3_600_000;

/**
 * Sends queued alerts (ADR 033): claims due rows of the outbox with `FOR UPDATE SKIP LOCKED`
 * (so several workers never send one row twice at once) and leases them for a while, checks each
 * URL (SSRF rules) and sends it in its destination's format. A 2xx marks it delivered; anything
 * else waits the next delay of the schedule, with jitter (half the delay plus a random part of the
 * other half), until `maxAttempts`, then it is marked failed. Errors never name the URL.
 */
export class AlertDispatcher {
  readonly #settings: AlertSettings;
  readonly #deps: DispatcherDeps;
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;
  #noKeyLogged = false;
  #prunedAt = 0;

  constructor(settings: AlertSettings, deps: DispatcherDeps) {
    this.#settings = settings;
    this.#deps = deps;
  }

  start(): void {
    if (!this.#settings.enabled || this.#loop) return;
    this.#loop = (async () => {
      while (!this.#stop.signal.aborted) {
        try {
          await this.runOnce();
        } catch (err) {
          this.#deps.logger.warn({ err }, 'alert delivery round failed');
        }
        try {
          await this.#deps.clock.sleep(this.#settings.pollIntervalMs, this.#stop.signal);
        } catch {
          return;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
  }

  /** One round: sends every due delivery it can claim; returns how many it attempted. */
  async runOnce(): Promise<number> {
    const { db, clock, logger, key } = this.#deps;
    if (!key) {
      if (!this.#noKeyLogged) {
        this.#noKeyLogged = true;
        logger.warn('alert deliveries paused: set ALERTS_ENCRYPTION_KEY or API_KEY_PEPPER');
      }
      return 0;
    }
    const now = clock.now();
    await this.#prune(now);
    // The lease: a worker that dies mid-send leaves the row due again after it.
    const leaseUntil = new Date(now + Math.max(60_000, this.#settings.sendTimeoutMs * 4));
    const claimed = await sql<{
      id: string;
      destination_id: string;
      payload: AlertPayload;
      attempts: number;
    }>`
      UPDATE alert_deliveries SET attempts = attempts + 1, next_attempt_at = ${leaseUntil}
       WHERE id IN (
         SELECT id FROM alert_deliveries
          WHERE status = 'pending' AND next_attempt_at <= ${new Date(now)}
          ORDER BY next_attempt_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, destination_id, payload, attempts`.execute(db);
    for (const row of claimed.rows) await this.#deliver(key, row);
    return claimed.rows.length;
  }

  async #deliver(
    key: Buffer,
    row: { id: string; destination_id: string; payload: AlertPayload; attempts: number },
  ): Promise<void> {
    const { db, clock } = this.#deps;
    const destination = await db
      .selectFrom('alert_destinations')
      .select(['kind', 'url_ciphertext', 'secret_ciphertext'])
      .where('id', '=', row.destination_id)
      .executeTakeFirst();
    if (!destination) return; // Deleted: its deliveries went with it (ON DELETE CASCADE).

    let url: string;
    let secret: string | null;
    try {
      url = openText(key, destination.url_ciphertext);
      secret = destination.secret_ciphertext ? openText(key, destination.secret_ciphertext) : null;
    } catch {
      return this.#settle(row, { error: 'cannot decrypt the URL (was the key changed?)' }, true);
    }
    const target = await vetTarget(url, this.#deps.resolve ?? systemResolver);
    if (!target.ok) return this.#settle(row, { error: target.reason }, target.permanent);
    const { body, headers } = renderDelivery(
      destination.kind,
      { id: row.id, payload: row.payload },
      secret,
      clock.now(),
    );
    try {
      const { status } = await (this.#deps.transport ?? httpsTransport)(
        target,
        body,
        headers,
        this.#settings.sendTimeoutMs,
      );
      if (status >= 200 && status < 300) return this.#settle(row, { status }, false);
      return this.#settle(row, { status, error: `the receiver answered ${status}` }, false);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const reason =
        err instanceof Error && err.message === 'timed out'
          ? 'timed out'
          : `connection failed${typeof code === 'string' ? ` (${code})` : ''}`;
      return this.#settle(row, { error: reason }, false);
    }
  }

  /** Records the attempt: delivered, retried after the next delay, or failed for good. */
  async #settle(
    row: { id: string; attempts: number },
    result: { status?: number; error?: string },
    permanent: boolean,
  ): Promise<void> {
    const { db, clock, random } = this.#deps;
    const now = clock.now();
    const delivered = result.error === undefined;
    const exhausted = permanent || row.attempts >= this.#settings.maxAttempts;
    const delay = RETRY_DELAYS_MS[Math.min(row.attempts, RETRY_DELAYS_MS.length) - 1] ?? 0;
    await db
      .updateTable('alert_deliveries')
      .set({
        status: delivered ? 'delivered' : exhausted ? 'failed' : 'pending',
        last_status: result.status ?? null,
        last_error: result.error?.slice(0, 300) ?? null,
        delivered_at: delivered ? new Date(now) : null,
        next_attempt_at: new Date(now + Math.floor(delay / 2 + random() * (delay / 2))),
      })
      .where('id', '=', row.id)
      .execute();
    if (!delivered && exhausted) {
      this.#deps.logger.warn(
        { deliveryId: row.id, attempts: row.attempts, reason: result.error },
        'alert delivery failed',
      );
    }
  }

  /** Deletes delivered and failed rows past the retention, at most once an hour. */
  async #prune(now: number): Promise<void> {
    if (now - this.#prunedAt < HOUR_MS) return;
    this.#prunedAt = now;
    await this.#deps.db
      .deleteFrom('alert_deliveries')
      .where('status', 'in', ['delivered', 'failed'])
      .where('created_at', '<', new Date(now - this.#settings.retentionDays * 24 * HOUR_MS))
      .execute();
  }
}
