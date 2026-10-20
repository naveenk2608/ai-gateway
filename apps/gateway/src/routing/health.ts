import { uuidv7, type Clock } from '@ai-gateway/shared';
import type { Db, Logger, Redis } from '@ai-gateway/shared/node';
import type { Deployment } from '../providers/registry.js';
import type { BreakerBoard, Transition } from './breaker.js';

/**
 * Makes breaker transitions visible fleet-wide (ADR 012): each instance writes its current state
 * per deployment to a Redis hash, and every transition to `provider_health_events`. Decisions stay
 * local; this is for operators and the dashboard. Writes are best effort and off the request path.
 */
export class HealthReporter {
  readonly #o: { redis: Redis; db: Db; logger: Logger; instanceId: string; prefix: string };

  constructor(options: {
    redis: Redis;
    db: Db;
    logger: Logger;
    instanceId: string;
    prefix?: string;
  }) {
    this.#o = { ...options, prefix: options.prefix ?? 'gw:' };
  }

  get instanceId(): string {
    return this.#o.instanceId;
  }

  report(t: Transition): void {
    const level = t.to === 'open' ? 'warn' : 'info';
    this.#o.logger[level](
      { deployment: t.deployment, from: t.from, to: t.to, reason: t.reason },
      'circuit breaker state changed',
    );
    const state = JSON.stringify({
      state: t.to,
      reason: t.reason,
      at: new Date(t.at).toISOString(),
    });
    void this.#o.redis
      .hset(`${this.#o.prefix}health:${t.deployment}`, this.#o.instanceId, state)
      .catch((err: unknown) => this.#o.logger.warn({ err }, 'could not publish breaker state'));
    void this.#o.db
      .insertInto('provider_health_events')
      .values({
        id: uuidv7(t.at),
        deployment: t.deployment,
        instance_id: this.#o.instanceId,
        from_state: t.from,
        to_state: t.to,
        reason: t.reason,
        occurred_at: new Date(t.at),
      })
      .execute()
      .catch((err: unknown) => this.#o.logger.warn({ err }, 'could not record breaker transition'));
  }
}

export interface HealthCheckerOptions {
  breakers: BreakerBoard;
  deployments: readonly Deployment[];
  clock: Clock;
  logger: Logger;
  intervalMs: number;
  timeoutMs: number;
}

/**
 * Active health checks for open breakers (ADR 012): every `intervalMs`, each deployment whose
 * breaker is open is probed with its provider's cheap check (no model runs); a pass half-opens the
 * breaker so the next request can be the trial, without waiting out the full open period.
 */
export class HealthChecker {
  readonly #o: HealthCheckerOptions;
  readonly #stop = new AbortController();
  #running: Promise<void> | undefined;

  constructor(options: HealthCheckerOptions) {
    this.#o = options;
  }

  start(): void {
    this.#running = (async () => {
      while (!this.#stop.signal.aborted) {
        try {
          await this.#o.clock.sleep(this.#o.intervalMs, this.#stop.signal);
        } catch {
          return;
        }
        await this.checkOpen();
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#running;
  }

  /** Probes every deployment whose breaker is open, at once. */
  async checkOpen(): Promise<void> {
    const open = this.#o.deployments.filter((d) => this.#o.breakers.get(d.id).state === 'open');
    await Promise.all(open.map((d) => this.#probe(d)));
  }

  async #probe(deployment: Deployment): Promise<void> {
    const probe = new AbortController();
    const timer = new AbortController();
    const onStop = () => probe.abort();
    this.#stop.signal.addEventListener('abort', onStop, { once: true });
    void this.#o.clock.sleep(this.#o.timeoutMs, timer.signal).then(
      () => probe.abort(),
      () => undefined,
    );
    try {
      await deployment.provider.probe(probe.signal);
      this.#o.breakers.get(deployment.id).probeSucceeded();
    } catch (err) {
      this.#o.logger.debug({ err, deployment: deployment.id }, 'health check failed');
    } finally {
      timer.abort();
      this.#stop.signal.removeEventListener('abort', onStop);
    }
  }
}
