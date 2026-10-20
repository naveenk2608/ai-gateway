import { costMicroUsd, priceAt, type Clock, type PriceVersion } from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';

export interface PriceRow extends PriceVersion {
  provider: string;
  model: string;
}

export type PriceLoader = () => Promise<PriceRow[]>;

const pairKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/**
 * Every price version (ADR 016), held in memory so the request path never queries Postgres. It is
 * reloaded every `refreshMs`; until then, a new price applies to reservations late, while the
 * worker still costs each request with the version in effect when it started.
 */
export class PriceBook {
  #byPair = new Map<string, PriceRow[]>();
  #loaded = false;
  readonly #load: PriceLoader;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #refreshMs: number;
  readonly #stop = new AbortController();

  constructor(options: { load: PriceLoader; clock: Clock; logger: Logger; refreshMs: number }) {
    this.#load = options.load;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#refreshMs = options.refreshMs;
  }

  /** A book with fixed prices, for tests. */
  static of(rows: PriceRow[], clock: Clock, logger: Logger): PriceBook {
    const book = new PriceBook({ load: () => Promise.resolve(rows), clock, logger, refreshMs: 0 });
    book.#set(rows);
    return book;
  }

  /** False until the first load succeeds; budgets cannot be reserved before then. */
  get loaded(): boolean {
    return this.#loaded;
  }

  async refresh(): Promise<void> {
    this.#set(await this.#load());
  }

  /**
   * Loads now and keeps reloading in the background until stop(). A failed first load (Postgres
   * down at startup) is retried on the same schedule rather than stopping the gateway.
   */
  async start(): Promise<void> {
    await this.#tryRefresh();
    void (async () => {
      while (!this.#stop.signal.aborted) {
        try {
          await this.#clock.sleep(this.#refreshMs, this.#stop.signal);
        } catch {
          return;
        }
        await this.#tryRefresh();
      }
    })();
  }

  stop(): void {
    this.#stop.abort();
  }

  /** Cost in micro-dollars at time `at`; 0 for a model with no price (it is not charged). */
  cost(
    provider: string,
    model: string,
    at: number,
    promptTokens: number,
    completionTokens: number,
  ): number {
    const price = priceAt(this.#byPair.get(pairKey(provider, model)) ?? [], at);
    return price ? costMicroUsd(promptTokens, completionTokens, price) : 0;
  }

  async #tryRefresh(): Promise<void> {
    try {
      await this.refresh();
    } catch (err) {
      this.#logger.warn(
        { err, loaded: this.#loaded },
        this.#loaded ? 'price reload failed; keeping the loaded prices' : 'price load failed',
      );
    }
  }

  #set(rows: PriceRow[]): void {
    this.#loaded = true;
    const byPair = new Map<string, PriceRow[]>();
    for (const row of rows) {
      const key = pairKey(row.provider, row.model);
      byPair.set(key, [...(byPair.get(key) ?? []), row]);
    }
    this.#byPair = byPair;
  }
}

export function databasePriceLoader(db: Db): PriceLoader {
  return async () => {
    const rows = await db.selectFrom('model_prices').selectAll().execute();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      inputMicroUsdPerMTok: row.input_micro_usd_per_mtok,
      outputMicroUsdPerMTok: row.output_micro_usd_per_mtok,
      effectiveFrom: row.effective_from.getTime(),
    }));
  };
}
