/** The time seam: anything time-based takes a Clock so tests can control time. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolves after `ms`; rejects with `signal.reason` if the signal aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The reason a signal aborted, as an Error (non-Error reasons are wrapped). */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted', { cause: reason });
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        if (signal) reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

interface Sleeper {
  at: number;
  seq: number;
  resolve: () => void;
}

/** Lets queued promise continuations run so they can schedule their next sleep. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A clock for tests: time only moves when `advance` is called, and sleepers wake in time order.
 */
export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #sleepers = new Set<Sleeper>();

  constructor(start = Date.UTC(2026, 0, 1)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const sleeper: Sleeper = {
        at: this.#now + Math.max(0, ms),
        seq: this.#seq++,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.#sleepers.delete(sleeper);
        if (signal) reject(abortReason(signal));
      };
      this.#sleepers.add(sleeper);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Number of sleeps waiting for time to pass. */
  get pendingSleeps(): number {
    return this.#sleepers.size;
  }

  /** Moves time forward by `ms`, waking each due sleeper in order and letting its code run. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      let next: Sleeper | undefined;
      for (const sleeper of this.#sleepers) {
        if (sleeper.at > target) continue;
        if (!next || sleeper.at < next.at || (sleeper.at === next.at && sleeper.seq < next.seq)) {
          next = sleeper;
        }
      }
      if (!next) break;
      this.#sleepers.delete(next);
      this.#now = next.at;
      next.resolve();
    }
    this.#now = target;
    await settle();
  }
}
