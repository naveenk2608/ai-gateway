import { uuidv7, type Clock } from '@ai-gateway/shared';
import type { Db, Logger, Redis } from '@ai-gateway/shared/node';
import { ProviderError } from '../providers/errors.js';
import type { Deployment } from '../providers/registry.js';
import type { Usage } from '../providers/types.js';
import type { BreakerBoard, Transition } from './breaker.js';
import type { QuotaBoard, QuotaTicket } from './quota.js';

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
  /**
   * The least time between two `chat` health checks of one deployment (ADR 026). Each failure in a
   * row doubles it, up to `chatMaxIntervalMs`; a pass starts it over.
   */
  chatIntervalMs: number;
  chatMaxIntervalMs: number;
  /** Counts `chat` health checks against the deployment's free-tier quota; absent in unit tests. */
  quotas?: QuotaBoard | undefined;
}

/** A `chat` health check asks for one token. */
const CHAT_PROBE = { messages: [{ role: 'user' as const, content: 'ping' }], maxTokens: 1 };
/** What a `chat` health check is counted as against a quota: a short prompt plus its one token. */
const CHAT_PROBE_PROMPT_TOKENS = 8;

/** A `chat` health check not sent: the deployment's quota is used up or it is on a cooldown. */
class ProbeSkipped extends Error {
  constructor(reason: string) {
    super(`health check skipped: ${reason}`);
    this.name = 'ProbeSkipped';
  }
}

/**
 * Active health checks for open breakers (ADR 012): every `intervalMs`, each deployment whose
 * breaker is open is probed; a pass half-opens the breaker so the next request can be the trial,
 * without waiting out the full open period. `models` probes run no model. `chat` probes ask for
 * one token, and a failed one keeps the breaker open until the next (ADR 026), because a provider
 * can list a model it will not serve. They back off: `chatIntervalMs` after a pass or a first
 * failure, then twice as long after each further failure in a row, up to `chatMaxIntervalMs`.
 */
export class HealthChecker {
  readonly #o: HealthCheckerOptions;
  readonly #stop = new AbortController();
  /** Each deployment's last `chat` check: when it started, and the failures in a row so far. */
  readonly #chat = new Map<string, { startedAt: number; failures: number }>();
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

  /** Probes every deployment whose breaker is open and whose check is due, at once. */
  async checkOpen(): Promise<void> {
    // A deployment with `healthCheck: "none"` is never probed: its breaker half-opens on time.
    const now = this.#o.clock.now();
    const open = this.#o.deployments.filter(
      (d) =>
        d.probes &&
        this.#o.breakers.get(d.id).state === 'open' &&
        (d.healthCheck !== 'chat' || this.#chatDue(d.id, now)),
    );
    await Promise.all(open.map((d) => this.#probe(d)));
  }

  #chatDue(deployment: string, now: number): boolean {
    const last = this.#chat.get(deployment);
    return last === undefined || now - last.startedAt >= this.#chatWait(last.failures);
  }

  /** The wait after a `chat` check, given the failures in a row it ended with: 1, 1, 2, 4, 8... */
  #chatWait(failures: number): number {
    const doubled = this.#o.chatIntervalMs * 2 ** Math.max(0, failures - 1);
    return Math.min(doubled, this.#o.chatMaxIntervalMs);
  }

  /** A `chat` check is a real model call, so it gets the deployment's own timeout if longer. */
  #timeoutFor(deployment: Deployment): number {
    return deployment.healthCheck === 'chat'
      ? Math.max(this.#o.timeoutMs, deployment.timeoutMs)
      : this.#o.timeoutMs;
  }

  async #probe(deployment: Deployment): Promise<void> {
    const probe = new AbortController();
    const timer = new AbortController();
    const onStop = () => probe.abort();
    const timeoutMs = this.#timeoutFor(deployment);
    this.#stop.signal.addEventListener('abort', onStop, { once: true });
    void this.#o.clock.sleep(timeoutMs, timer.signal).then(
      () => probe.abort(),
      () => undefined,
    );
    const breaker = this.#o.breakers.get(deployment.id);
    const chat = deployment.healthCheck === 'chat';
    const before = this.#chat.get(deployment.id)?.failures ?? 0;
    try {
      if (chat) await this.#chatProbe(deployment, probe.signal);
      else await deployment.provider.probe(probe.signal);
      if (chat) this.#chatEnded(deployment.id, 0);
      breaker.probeSucceeded();
    } catch (err) {
      this.#o.logger.debug({ err, deployment: deployment.id }, 'health check failed');
      if (chat && !(err instanceof ProbeSkipped)) {
        const failures = before + 1;
        this.#chatEnded(deployment.id, failures);
        // Stay open until the next chat check has run (it starts within an interval of being due).
        breaker.holdOpen(this.#chatWait(failures) + this.#o.intervalMs + timeoutMs);
        this.#o.logger.info(
          {
            deployment: deployment.id,
            failuresInARow: failures,
            nextCheckInMs: this.#chatWait(failures),
          },
          'chat health check failed; breaker stays open',
        );
      }
    } finally {
      timer.abort();
      this.#stop.signal.removeEventListener('abort', onStop);
    }
  }

  /**
   * One request for a single token. Passes when the model answers, or when the provider refuses
   * only the request (400): the model is served then. Counted against the deployment's quota, and
   * skipped while that is used up or the deployment is on a 429 cooldown (ADR 025).
   */
  async #chatProbe(deployment: Deployment, signal: AbortSignal): Promise<void> {
    const failures = this.#chat.get(deployment.id)?.failures ?? 0;
    this.#chat.set(deployment.id, { startedAt: this.#o.clock.now(), failures });
    const quotas = this.#o.quotas;
    let ticket: QuotaTicket | null = null;
    if (quotas) {
      const check = await quotas.acquire(deployment, {
        input: CHAT_PROBE_PROMPT_TOKENS,
        output: 1,
      });
      if (!check.ok) throw new ProbeSkipped(check.reason);
      ticket = check.ticket;
    }
    let used: Usage | null = null;
    try {
      const result = await deployment.provider.chat(
        { ...CHAT_PROBE, model: deployment.providerModel },
        signal,
      );
      used = result.usage;
      quotas?.observe(deployment, result.rateLimit);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'rate_limited') {
        quotas?.cooldown(deployment.id, err.retryAfterMs);
      }
      if (!(err instanceof ProviderError && err.kind === 'bad_request')) throw err;
    } finally {
      quotas?.settle(ticket, used, CHAT_PROBE_PROMPT_TOKENS);
    }
  }

  /** Records how a `chat` check ended: 0 failures in a row after a pass. */
  #chatEnded(deployment: string, failures: number): void {
    const last = this.#chat.get(deployment);
    if (last) last.failures = failures;
  }
}
