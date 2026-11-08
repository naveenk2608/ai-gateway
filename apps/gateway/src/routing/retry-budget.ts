import type { Clock } from '@ai-gateway/shared';

export interface RetryBudgetSettings {
  /** Off: retries are bounded only per request (RETRY_BUDGET_ENABLED). */
  enabled: boolean;
  /** Retries in the window may be at most this share of first tries in it (RETRY_BUDGET_RATIO). */
  ratio: number;
  /** ...or this many, whichever is more, so quiet periods can still retry (RETRY_BUDGET_MIN_RETRIES). */
  minRetries: number;
  /** The sliding window, in ms (RETRY_BUDGET_WINDOW_MS). */
  windowMs: number;
}

/** Start times within the window, oldest first. */
class Window {
  readonly #times: number[] = [];

  add(at: number): void {
    this.#times.push(at);
  }

  count(now: number, windowMs: number): number {
    const from = now - windowMs;
    let drop = 0;
    while (drop < this.#times.length && this.#times[drop]! <= from) drop++;
    if (drop > 0) this.#times.splice(0, drop);
    return this.#times.length;
  }
}

/**
 * A retry budget per deployment on this instance (ADR 011, note of 2026-11-08): within a sliding
 * window, retries on a deployment may be at most `ratio` of its first tries, or `minRetries`,
 * whichever is more (Envoy's `max(min_retry_concurrency, budget_percent x requests)`, counted over
 * a window like Finagle's and Linkerd's budgets). A first try is any try that is not a retry on the
 * same deployment, so fallbacks count as first tries and are never limited by it.
 */
export class RetryBudget {
  readonly settings: RetryBudgetSettings;
  readonly #clock: Clock;
  readonly #first = new Map<string, Window>();
  readonly #retries = new Map<string, Window>();
  readonly #onSkip: ((deployment: string) => void) | undefined;

  constructor(settings: RetryBudgetSettings, clock: Clock, onSkip?: (deployment: string) => void) {
    this.settings = settings;
    this.#clock = clock;
    this.#onSkip = onSkip;
  }

  #window(map: Map<string, Window>, deployment: string): Window {
    let w = map.get(deployment);
    if (!w) {
      w = new Window();
      map.set(deployment, w);
    }
    return w;
  }

  /** A request's first try on `deployment` started. */
  firstTry(deployment: string): void {
    if (!this.settings.enabled) return;
    this.#window(this.#first, deployment).add(this.#clock.now());
  }

  /** Retries `deployment` may still take in the current window, and the number allowed in it. */
  usage(deployment: string): { first: number; retries: number; allowed: number } {
    const now = this.#clock.now();
    const { windowMs, ratio, minRetries } = this.settings;
    const first = this.#window(this.#first, deployment).count(now, windowMs);
    const retries = this.#window(this.#retries, deployment).count(now, windowMs);
    // Rounded down, with a margin for float error (0.2 x 15 is 3.0000000000000004).
    const allowed = Math.max(minRetries, Math.floor(ratio * first + 1e-9));
    return { first, retries, allowed };
  }

  /**
   * Whether a retry on `deployment` may start now; if so, it is counted. A refusal is counted for
   * the `gateway_retry_budget_skips_total` metric.
   */
  tryRetry(deployment: string): boolean {
    if (!this.settings.enabled) return true;
    const { retries, allowed } = this.usage(deployment);
    if (retries >= allowed) {
      this.#onSkip?.(deployment);
      return false;
    }
    this.#window(this.#retries, deployment).add(this.#clock.now());
    return true;
  }
}
