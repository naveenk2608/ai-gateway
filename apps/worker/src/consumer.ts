import {
  describeIssue,
  usageEventSchema,
  uuidv7,
  type Clock,
  type UsageEvent,
} from '@ai-gateway/shared';
import type { Db, Logger, Redis } from '@ai-gateway/shared/node';
import { ingestEvents } from './ingest.js';
import type { WorkerMetrics } from './metrics.js';
import { pruneRollups, type RollupRetention } from './retention.js';

export interface ConsumerOptions {
  /** A dedicated connection: XREADGROUP BLOCK holds it. */
  redis: Redis;
  db: Db;
  logger: Logger;
  clock: Clock;
  stream: string;
  dlqStream: string;
  group: string;
  /** Unique per process, so a restarted worker's leftovers are claimed like any dead consumer's. */
  consumer: string;
  batchSize: number;
  blockMs: number;
  claimIdleMs: number;
  maxDeliveries: number;
  trimIntervalMs: number;
  /** Rollup retention (ADR 015), applied every `intervalMs`; omitted, rollups are kept forever. */
  retention?: RollupRetention & { intervalMs: number };
  /** Records consumption, batch and retention timings (ADR 017). */
  metrics?: WorkerMetrics;
  /** Test-only fault injection: throw SimulatedCrash to stop the consumer as a kill would. */
  faults?: { crash?(point: 'before-commit' | 'after-commit'): void };
}

/** Thrown by fault injection: the consumer stops on the spot, acknowledging nothing more. */
export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

interface Entry {
  id: string;
  /** The raw `event` field, or null if the entry has none. */
  raw: string | null;
}

type Parsed =
  { ok: true; entry: Entry; event: UsageEvent } | { ok: false; entry: Entry; error: string };

export interface ConsumerStats {
  processed: number;
  deadLettered: number;
  reclaimed: number;
}

const BUSYGROUP = /BUSYGROUP/;
const NOGROUP = /NOGROUP/;
const MAX_BACKOFF_MS = 30_000;

/** Errors that mean "Postgres is unreachable right now", worth retrying in place. */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(code)) return true;
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code))
      return true;
  }
  return /Connection terminated|timeout exceeded when trying to connect|Query read timeout/i.test(
    err.message,
  );
}

function fieldValue(fields: unknown, name: string): string | null {
  if (!Array.isArray(fields)) return null;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === name && typeof fields[i + 1] === 'string') return fields[i + 1] as string;
  }
  return null;
}

function toEntries(items: unknown): Entry[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!Array.isArray(item) || typeof item[0] !== 'string') return [];
    return [{ id: item[0], raw: fieldValue(item[1], 'event') }];
  });
}

function parse(entry: Entry): Parsed {
  if (entry.raw === null) return { ok: false, entry, error: 'entry has no event field' };
  let json: unknown;
  try {
    json = JSON.parse(entry.raw);
  } catch {
    return { ok: false, entry, error: 'event is not valid JSON' };
  }
  const result = usageEventSchema.safeParse(json);
  if (!result.success) {
    // Issue messages name the rule and path, never the value.
    return {
      ok: false,
      entry,
      error: result.error.issues.slice(0, 5).map(describeIssue).join('; '),
    };
  }
  return { ok: true, entry, event: result.data };
}

function eventIdOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const id = (JSON.parse(raw) as { eventId?: unknown }).eventId;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Consumes usage events from a Redis Stream consumer group (ADR 014):
 *
 * - reads batches with XREADGROUP and inserts each batch in one Postgres transaction;
 * - acknowledges (XACK) only after the transaction commits, so a crash re-delivers instead of
 *   losing, and idempotent inserts make the re-delivery harmless;
 * - claims entries left pending too long (a dead consumer, or ones that failed) with XAUTOCLAIM;
 * - moves an entry delivered more than `maxDeliveries` times to the dead-letter stream and the
 *   failed_events table, so one bad event never blocks the rest;
 * - retries in place while Postgres is unreachable, so an outage does not use up deliveries;
 * - trims entries every consumer has acknowledged, so the stream does not grow without bound.
 */
export class UsageConsumer {
  readonly #o: ConsumerOptions;
  readonly #stop = new AbortController();
  readonly #lastErrors = new Map<string, string>();
  #running: Promise<void> | undefined;
  #nextClaimAt = 0;
  #nextTrimAt = 0;
  #nextPruneAt = 0;
  /** A rollup prune in progress; it runs beside the loop so a slow delete never delays reads. */
  #pruning: Promise<void> | undefined;
  readonly #stats: ConsumerStats = { processed: 0, deadLettered: 0, reclaimed: 0 };

  constructor(options: ConsumerOptions) {
    this.#o = options;
  }

  get stats(): ConsumerStats {
    return { ...this.#stats };
  }

  /** Starts the loop; resolves once the consumer group exists. */
  async start(): Promise<void> {
    await this.#ensureGroup();
    this.#o.logger.info(
      { stream: this.#o.stream, group: this.#o.group, consumer: this.#o.consumer },
      'usage consumer started',
    );
    this.#running = this.#loop();
  }

  /** Finishes the batch in hand, then stops. Unfinished work stays pending for the next worker. */
  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#running;
    await this.#pruning;
  }

  /** Resolves when the loop ends (after stop() or a simulated crash). */
  get done(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async #ensureGroup(): Promise<void> {
    try {
      await this.#o.redis.call('XGROUP', 'CREATE', this.#o.stream, this.#o.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && BUSYGROUP.test(err.message))) throw err;
    }
  }

  /**
   * Redis restarted without its data (a host with no persistence, such as Render's free Redis):
   * the stream and its group are gone. Recreating the group from the start of the stream picks up
   * every event written since.
   */
  async #recreateGroup(): Promise<boolean> {
    this.#o.logger.warn('usage consumer group missing, recreating it (Redis lost its data)');
    try {
      await this.#ensureGroup();
      return true;
    } catch (err) {
      this.#o.logger.warn({ err }, 'recreating the usage consumer group failed');
      return false;
    }
  }

  get #stopping(): boolean {
    return this.#stop.signal.aborted;
  }

  async #sleep(ms: number): Promise<void> {
    await this.#o.clock.sleep(ms, this.#stop.signal).catch(() => undefined);
  }

  async #loop(): Promise<void> {
    let backoffMs = 500;
    while (!this.#stopping) {
      try {
        const now = this.#o.clock.now();
        if (now >= this.#nextClaimAt) {
          await this.#reclaim();
          this.#nextClaimAt = now + Math.max(1, Math.floor(this.#o.claimIdleMs / 2));
        }
        if (now >= this.#nextTrimAt) {
          await this.#trim();
          this.#nextTrimAt = now + this.#o.trimIntervalMs;
        }
        if (this.#o.retention && now >= this.#nextPruneAt && !this.#pruning) {
          this.#nextPruneAt = now + this.#o.retention.intervalMs;
          this.#pruning = this.#prune(this.#o.retention, now).finally(() => {
            this.#pruning = undefined;
          });
        }
        const entries = await this.#read();
        if (entries.length > 0) await this.#process(entries);
        backoffMs = 500;
      } catch (err) {
        if (err instanceof SimulatedCrash) {
          this.#o.logger.warn({ err }, 'usage consumer crashed (simulated)');
          return;
        }
        if (this.#stopping) return;
        if (err instanceof Error && NOGROUP.test(err.message) && (await this.#recreateGroup())) {
          continue;
        }
        this.#o.metrics?.loopError();
        this.#o.logger.error({ err, retryInMs: backoffMs }, 'usage consumer error');
        await this.#sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  async #read(): Promise<Entry[]> {
    const reply = await this.#o.redis.call(
      'XREADGROUP',
      'GROUP',
      this.#o.group,
      this.#o.consumer,
      'COUNT',
      this.#o.batchSize,
      'BLOCK',
      this.#o.blockMs,
      'STREAMS',
      this.#o.stream,
      '>',
    );
    if (!Array.isArray(reply) || reply.length === 0) return [];
    // RESP2: [[stream, entries]]. A RESP3 map arrives flattened: [stream, entries].
    const first: unknown = reply[0];
    return toEntries(Array.isArray(first) ? first[1] : reply[1]);
  }

  /** Inserts valid events; leaves invalid or failing ones pending, to be retried or dead-lettered. */
  async #process(entries: Entry[]): Promise<void> {
    const parsed = entries.map(parse);
    for (const p of parsed) {
      if (!p.ok) {
        this.#lastErrors.set(p.entry.id, p.error);
        this.#o.logger.warn({ streamId: p.entry.id, error: p.error }, 'invalid usage event');
      }
    }
    const valid = parsed.filter((p): p is Extract<Parsed, { ok: true }> => p.ok);
    if (valid.length === 0) return;
    try {
      await this.#insertAndAck(valid);
    } catch (err) {
      if (err instanceof SimulatedCrash || this.#stopping) throw err;
      // One event the database refuses (e.g. its project was deleted) must not hold back the
      // others: retry them one at a time and leave only the failures pending.
      this.#o.logger.warn(
        { err, count: valid.length },
        'batch insert failed, inserting one by one',
      );
      for (const p of valid) {
        try {
          await this.#insertAndAck([p]);
        } catch (single) {
          if (single instanceof SimulatedCrash || this.#stopping) throw single;
          const message = single instanceof Error ? single.message : String(single);
          this.#lastErrors.set(p.entry.id, `database rejected the event: ${message}`);
          this.#o.logger.warn({ err: single, streamId: p.entry.id }, 'usage event insert failed');
        }
      }
    }
  }

  async #insertAndAck(batch: Extract<Parsed, { ok: true }>[]): Promise<void> {
    const metrics = this.#o.metrics;
    await this.#retryWhileDbDown(async () => {
      const started = performance.now();
      await this.#o.db.transaction().execute(async (trx) => {
        await ingestEvents(
          trx,
          batch.map((p) => p.event),
          metrics && ((seconds) => metrics.rollup(seconds)),
        );
        this.#o.faults?.crash?.('before-commit');
      });
      metrics?.batch((performance.now() - started) / 1000);
    });
    this.#o.faults?.crash?.('after-commit');
    const ids = batch.map((p) => p.entry.id);
    await this.#o.redis.call('XACK', this.#o.stream, this.#o.group, ...ids);
    for (const id of ids) this.#lastErrors.delete(id);
    this.#stats.processed += ids.length;
    this.#o.metrics?.consumed(ids.length);
  }

  /** Retries `work` while Postgres is unreachable; other errors are thrown at once. */
  async #retryWhileDbDown<T>(work: () => Promise<T>): Promise<T> {
    let backoffMs = 500;
    for (;;) {
      try {
        return await work();
      } catch (err) {
        if (!isTransientDbError(err) || this.#stopping) throw err;
        this.#o.logger.warn({ err, retryInMs: backoffMs }, 'postgres unavailable, retrying batch');
        await this.#sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** Claims entries idle longer than claimIdleMs, dead-letters the over-delivered, processes the rest. */
  async #reclaim(): Promise<void> {
    let cursor = '0-0';
    // A bounded number of pages per pass, so new events are not starved.
    for (let page = 0; page < 10 && !this.#stopping; page++) {
      const reply = (await this.#o.redis.call(
        'XAUTOCLAIM',
        this.#o.stream,
        this.#o.group,
        this.#o.consumer,
        this.#o.claimIdleMs,
        cursor,
        'COUNT',
        this.#o.batchSize,
      )) as [string, unknown, unknown];
      cursor = reply[0];
      const entries = toEntries(reply[1]);
      // Entries trimmed from the stream while pending: nothing left to process.
      const deleted = Array.isArray(reply[2]) ? (reply[2] as string[]) : [];
      if (deleted.length > 0) {
        await this.#o.redis.call('XACK', this.#o.stream, this.#o.group, ...deleted);
      }
      if (entries.length > 0) {
        this.#stats.reclaimed += entries.length;
        this.#o.metrics?.reclaimed(entries.length);
        const deliveries = await this.#deliveryCounts(entries);
        const poison = entries.filter((e) => (deliveries.get(e.id) ?? 0) > this.#o.maxDeliveries);
        for (const entry of poison) await this.#deadLetter(entry, deliveries.get(entry.id) ?? 0);
        const retry = entries.filter((e) => !poison.includes(e));
        if (retry.length > 0) await this.#process(retry);
      }
      if (cursor === '0-0') break;
    }
  }

  /** Delivery counts for entries this consumer now owns. */
  async #deliveryCounts(entries: Entry[]): Promise<Map<string, number>> {
    const reply = (await this.#o.redis.call(
      'XPENDING',
      this.#o.stream,
      this.#o.group,
      entries[0]!.id,
      entries.at(-1)!.id,
      entries.length * 2,
      this.#o.consumer,
    )) as [string, string, number, number][];
    return new Map(reply.map(([id, , , count]) => [id, Number(count)]));
  }

  /** Records the entry in failed_events and the DLQ stream, then acknowledges it. */
  async #deadLetter(entry: Entry, deliveries: number): Promise<void> {
    const parsed = parse(entry);
    const error =
      this.#lastErrors.get(entry.id) ??
      (parsed.ok ? 'not processed after repeated deliveries' : parsed.error);
    await this.#retryWhileDbDown(() =>
      this.#o.db
        .insertInto('failed_events')
        .values({
          id: uuidv7(),
          stream: this.#o.stream,
          stream_message_id: entry.id,
          event_id: eventIdOf(entry.raw),
          payload: entry.raw ?? '',
          error,
          delivery_count: deliveries,
        })
        .onConflict((oc) => oc.columns(['stream', 'stream_message_id']).doNothing())
        .execute(),
    );
    await this.#o.redis.call(
      'XADD',
      this.#o.dlqStream,
      '*',
      'source_id',
      entry.id,
      'event',
      entry.raw ?? '',
      'error',
      error,
      'deliveries',
      String(deliveries),
    );
    await this.#o.redis.call('XACK', this.#o.stream, this.#o.group, entry.id);
    this.#lastErrors.delete(entry.id);
    this.#stats.deadLettered++;
    this.#o.metrics?.deadLettered();
    this.#o.logger.error(
      { streamId: entry.id, deliveries, error },
      'usage event moved to the dead-letter stream',
    );
  }

  /** Deletes expired rollup rows. A failure is logged and retried at the next interval. */
  async #prune(retention: RollupRetention, now: number): Promise<void> {
    try {
      const started = performance.now();
      const deleted = await pruneRollups(this.#o.db, now, retention);
      this.#o.metrics?.pruned((performance.now() - started) / 1000, deleted);
      if (deleted.minute + deleted.hour + deleted.day > 0) {
        this.#o.logger.info({ deleted }, 'expired rollup rows deleted');
      }
    } catch (err) {
      this.#o.logger.warn({ err }, 'rollup retention failed');
    }
  }

  /**
   * Removes entries older than anything still pending. Only safe with a single consumer group on
   * the stream, so it does nothing if there are others.
   */
  async #trim(): Promise<void> {
    const groups = (await this.#o.redis.call('XINFO', 'GROUPS', this.#o.stream)) as unknown[][];
    if (groups.length !== 1) return;
    const info = groups[0]!;
    const field = (name: string) => info[info.indexOf(name) + 1];
    const pending = Number(field('pending'));
    let minId = String(field('last-delivered-id'));
    if (pending > 0) {
      const summary = (await this.#o.redis.call('XPENDING', this.#o.stream, this.#o.group)) as [
        number,
        string | null,
      ];
      if (summary[1]) minId = summary[1];
    }
    if (minId === '0-0') return;
    await this.#o.redis.call('XTRIM', this.#o.stream, 'MINID', '~', minId);
  }
}
