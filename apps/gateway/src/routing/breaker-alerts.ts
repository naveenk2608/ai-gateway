import type { Clock } from '@ai-gateway/shared';
import { enqueueAlert, type Db, type Logger } from '@ai-gateway/shared/node';

export interface BreakerAlertOptions {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** ALERTS_BREAKER_INTERVAL_MS. */
  intervalMs: number;
  /** ALERTS_ENABLED. */
  enabled: boolean;
  /** The provider of a deployment, named in the alert. */
  provider: (deployment: string) => string | undefined;
}

/**
 * Queues a "breaker opened" webhook alert (M15, ADR 033) from the gateway, which is where breakers
 * live: at most once per deployment per `intervalMs` (ALERTS_BREAKER_INTERVAL_MS). The dedupe key
 * is the interval's number, so several instances opening the same breaker queue it once. It goes
 * to every destination that chose `breaker`. Never throws and never blocks routing.
 */
export class BreakerAlerts {
  readonly #o: BreakerAlertOptions;
  readonly #last = new Map<string, number>();

  constructor(options: BreakerAlertOptions) {
    this.#o = options;
  }

  /** A breaker opened; returns the queueing (tests await it). */
  opened(deployment: string): Promise<void> {
    if (!this.#o.enabled) return Promise.resolve();
    const now = this.#o.clock.now();
    const window = Math.floor(now / this.#o.intervalMs);
    if (this.#last.get(deployment) === window) return Promise.resolve();
    this.#last.set(deployment, window);
    return enqueueAlert(this.#o.db, {
      projectId: null,
      type: 'breaker.opened',
      dedupeKey: `breaker:${deployment}:${window}`,
      payload: { deployment, provider: this.#o.provider(deployment) ?? null },
      occurredAt: now,
    }).then(
      () => undefined,
      (err: unknown) =>
        this.#o.logger.warn({ err, deployment }, 'breaker alert could not be queued'),
    );
  }
}
