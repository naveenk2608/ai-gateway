import type { UsageEvent } from '@ai-gateway/shared';
import type { Registry } from '@ai-gateway/shared/node';
import { Counter, Gauge, Histogram } from 'prom-client';
import type { EventBus } from './events/bus.js';
import type { ProviderErrorKind } from './providers/errors.js';
import type { BreakerBoard, BreakerState, Transition } from './routing/breaker.js';

/**
 * The gateway's Prometheus metrics (ADR 017). Label values come only from fixed sets or from
 * config (deployments, models), never from request IDs, key IDs or anything a client sends, so
 * the number of series stays bounded however much traffic arrives.
 */

/** Methods Fastify routes; anything else is labelled `other`. */
const METHODS: ReadonlySet<string> = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);

/** Every ProviderErrorKind; the Record type makes a new kind a compile error here. */
const ERROR_KINDS: Record<ProviderErrorKind, true> = {
  timeout: true,
  rate_limited: true,
  server_error: true,
  connection: true,
  invalid_response: true,
  bad_request: true,
  auth: true,
  not_found: true,
  canceled: true,
};
/** Attempt outcomes as the trace records them: success, a ProviderErrorKind, or error. */
const OUTCOMES: ReadonlySet<string> = new Set(['success', 'error', ...Object.keys(ERROR_KINDS)]);

/** Admission error codes (limits and budgets, ADR 008-010) and the reason label each counts as. */
const REJECTION_REASONS: Readonly<Record<string, string>> = {
  rpm_limit_exceeded: 'rpm',
  tpm_limit_exceeded: 'tpm',
  concurrency_limit_exceeded: 'concurrency',
  budget_exceeded: 'budget',
  request_exceeds_limit: 'request_too_large',
  limits_unavailable: 'limits_unavailable',
};

const BREAKER_STATES: readonly BreakerState[] = ['closed', 'open', 'half_open'];

/** Seconds: fast admin reads up to long streams. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const TTFT_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
const TOKENS_PER_SECOND_BUCKETS = [1, 5, 10, 20, 50, 100, 200, 500, 1_000, 5_000];
/** (estimated - reported) / reported: negative under-estimates, positive over-estimates. */
const ESTIMATE_ERROR_BUCKETS = [-0.5, -0.25, -0.1, -0.05, 0, 0.05, 0.1, 0.25, 0.5, 1, 2];

/** The value itself when it is in the allowed set, `other` otherwise. */
export function bounded(value: string | null | undefined, allowed: ReadonlySet<string>): string {
  return value != null && allowed.has(value) ? value : 'other';
}

/** What the metrics may name: the configured deployments and logical models. */
export interface MetricLabels {
  deployments: readonly { id: string; provider: string; providerModel: string }[];
  models: readonly string[];
}

/** Live state read when Prometheus scrapes. */
export interface MetricSources {
  breakers: BreakerBoard;
  events: EventBus;
  pool: { totalCount: number; idleCount: number; waitingCount: number };
  /** Named round trips (postgres, redis); each rejects when its dependency is down. */
  checks: Record<string, () => Promise<void>>;
  timeoutMs: number;
}

export class GatewayMetrics {
  readonly registry: Registry;
  readonly #deployments: ReadonlySet<string>;
  readonly #providers: ReadonlySet<string>;
  readonly #providerModels: ReadonlySet<string>;
  readonly #models: ReadonlySet<string>;
  readonly #httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly #attempts: Counter<'provider' | 'deployment' | 'model' | 'outcome'>;
  readonly #retries: Counter<'deployment'>;
  readonly #fallbacks: Counter<'model'>;
  readonly #transitions: Counter<'deployment' | 'to'>;
  readonly #cache: Counter<'result'>;
  readonly #rejections: Counter<'reason'>;
  readonly #ttft: Histogram<'deployment'>;
  readonly #tokensPerSecond: Histogram<'deployment' | 'stream'>;
  readonly #estimateError: Histogram<'deployment'>;

  constructor(registry: Registry, labels: MetricLabels) {
    this.registry = registry;
    this.#deployments = new Set(labels.deployments.map((d) => d.id));
    this.#providers = new Set(labels.deployments.map((d) => d.provider));
    this.#providerModels = new Set(labels.deployments.map((d) => d.providerModel));
    this.#models = new Set(labels.models);
    const registers = [registry];

    this.#httpDuration = new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'HTTP requests by method, route pattern and status, until the response ended (streams included). The _count series is the request count.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    this.#attempts = new Counter({
      name: 'gateway_upstream_attempts_total',
      help: 'Provider attempts by provider, deployment, provider model and outcome (success or the error kind).',
      labelNames: ['provider', 'deployment', 'model', 'outcome'],
      registers,
    });
    this.#retries = new Counter({
      name: 'gateway_retries_total',
      help: 'Attempts that retried the same deployment after a retryable failure (ADR 011).',
      labelNames: ['deployment'],
      registers,
    });
    this.#fallbacks = new Counter({
      name: 'gateway_fallbacks_total',
      help: 'Attempts that moved to another deployment of the logical model after a failure.',
      labelNames: ['model'],
      registers,
    });
    this.#transitions = new Counter({
      name: 'gateway_circuit_breaker_transitions_total',
      help: 'Circuit-breaker state changes on this instance, by deployment and new state (ADR 012).',
      labelNames: ['deployment', 'to'],
      registers,
    });
    this.#cache = new Counter({
      name: 'gateway_cache_lookups_total',
      help: 'Response-cache lookups by result, hit or miss (ADR 013).',
      labelNames: ['result'],
      registers,
    });
    this.#rejections = new Counter({
      name: 'gateway_admission_rejections_total',
      help: 'Requests refused by rate limits, token limits, concurrency limits or budgets, by reason.',
      labelNames: ['reason'],
      registers,
    });
    this.#ttft = new Histogram({
      name: 'gateway_ttft_seconds',
      help: 'Streaming requests: time from arrival to the first token sent to the client, by the deployment that answered. Cache hits excluded.',
      labelNames: ['deployment'],
      buckets: TTFT_BUCKETS,
      registers,
    });
    this.#tokensPerSecond = new Histogram({
      name: 'gateway_output_tokens_per_second',
      help: 'Reported completion tokens per second of the successful attempt (streams: after the first token).',
      labelNames: ['deployment', 'stream'],
      buckets: TOKENS_PER_SECOND_BUCKETS,
      registers,
    });
    this.#estimateError = new Histogram({
      name: 'gateway_prompt_token_estimate_error_ratio',
      help: 'Prompt-token estimate made before the call vs the provider-reported count: (estimated - reported) / reported.',
      labelNames: ['deployment'],
      buckets: ESTIMATE_ERROR_BUCKETS,
      registers,
    });
  }

  /** `route` is the matched route pattern (never the raw URL); undefined for unmatched URLs. */
  httpRequest(method: string, route: string | undefined, statusCode: number, seconds: number) {
    this.#httpDuration.observe(
      {
        method: bounded(method, METHODS),
        route: route ?? 'unmatched',
        status_code: String(statusCode),
      },
      seconds,
    );
  }

  cacheLookup(hit: boolean): void {
    this.#cache.inc({ result: hit ? 'hit' : 'miss' });
  }

  breakerTransition(t: Transition): void {
    this.#transitions.inc({ deployment: bounded(t.deployment, this.#deployments), to: t.to });
  }

  /** Records a finished /v1 request from the usage event it produced. */
  requestFinished(event: UsageEvent): void {
    const { request } = event;
    const reason = request.errorCode === null ? undefined : REJECTION_REASONS[request.errorCode];
    if (request.status === 'rejected' && reason !== undefined) this.#rejections.inc({ reason });

    const attempts = [...event.attempts].sort((a, b) => a.attemptNumber - b.attemptNumber);
    attempts.forEach((attempt, i) => {
      const deployment = bounded(attempt.deployment, this.#deployments);
      this.#attempts.inc({
        provider: bounded(attempt.provider, this.#providers),
        deployment,
        model: bounded(attempt.providerModel, this.#providerModels),
        outcome: bounded(attempt.outcome, OUTCOMES),
      });
      const previous = attempts[i - 1];
      if (previous === undefined) return;
      if (previous.deployment === attempt.deployment) this.#retries.inc({ deployment });
      else this.#fallbacks.inc({ model: bounded(request.model, this.#models) });
    });

    const final = attempts.at(-1);
    if (event.cacheHit || final?.outcome !== 'success') return;
    const deployment = bounded(final.deployment, this.#deployments);
    if (request.stream && request.ttftMs !== null) {
      this.#ttft.observe({ deployment }, request.ttftMs / 1000);
    }
    if (event.usageSource !== 'reported' || !event.usage) return;
    const generatingMs = final.latencyMs - (request.stream ? (final.ttftMs ?? 0) : 0);
    if (event.usage.completionTokens > 0 && generatingMs > 0) {
      this.#tokensPerSecond.observe(
        { deployment, stream: String(request.stream) },
        event.usage.completionTokens / (generatingMs / 1000),
      );
    }
    const reported = event.usage.promptTokens;
    if (reported > 0 && event.estimatedPromptTokens !== undefined) {
      this.#estimateError.observe(
        { deployment },
        (event.estimatedPromptTokens - reported) / reported,
      );
    }
  }

  /** Registers gauges and counters read from live state at scrape time. */
  watch(sources: MetricSources): void {
    const registers = [this.registry];
    const deployments = this.#deployments;
    new Gauge({
      name: 'gateway_circuit_breaker_state',
      help: "Each deployment's breaker on this instance: 1 for its current state, 0 for the others.",
      labelNames: ['deployment', 'state'],
      registers,
      collect() {
        for (const breaker of sources.breakers.all()) {
          const current = breaker.state;
          const deployment = bounded(breaker.deployment, deployments);
          for (const state of BREAKER_STATES)
            this.set({ deployment, state }, state === current ? 1 : 0);
        }
      },
    });

    new Counter({
      name: 'gateway_usage_events_published_total',
      help: 'Usage events written to the event bus.',
      registers,
      collect() {
        this.reset();
        this.inc(sources.events.stats().published);
      },
    });
    new Counter({
      name: 'gateway_usage_events_dropped_total',
      help: 'Usage events lost because the in-memory buffer was full while the event bus was unreachable.',
      registers,
      collect() {
        this.reset();
        this.inc(sources.events.stats().dropped);
      },
    });
    new Gauge({
      name: 'gateway_usage_events_buffered',
      help: 'Usage events waiting in memory to be written to the event bus.',
      registers,
      collect() {
        this.set(sources.events.stats().buffered);
      },
    });

    new Gauge({
      name: 'gateway_pg_pool_clients',
      help: 'Postgres pool clients: total open, idle, and requests waiting for one.',
      labelNames: ['state'],
      registers,
      collect() {
        this.set({ state: 'total' }, sources.pool.totalCount);
        this.set({ state: 'idle' }, sources.pool.idleCount);
        this.set({ state: 'waiting' }, sources.pool.waitingCount);
      },
    });

    // Both dependency gauges are collected in the same scrape; one round trip serves them.
    let probing: Promise<Map<string, { up: boolean; seconds: number }>> | undefined;
    const probe = () =>
      (probing ??= probeAll(sources.checks, sources.timeoutMs).finally(() => {
        probing = undefined;
      }));
    new Gauge({
      name: 'gateway_dependency_up',
      help: 'Whether a round trip to the dependency succeeded during this scrape.',
      labelNames: ['dependency'],
      registers,
      async collect() {
        for (const [dependency, result] of await probe())
          this.set({ dependency }, result.up ? 1 : 0);
      },
    });
    new Gauge({
      name: 'gateway_dependency_latency_seconds',
      help: 'Round-trip time to the dependency during this scrape (up to the timeout when it failed).',
      labelNames: ['dependency'],
      registers,
      async collect() {
        for (const [dependency, result] of await probe()) this.set({ dependency }, result.seconds);
      },
    });
  }
}

async function probeAll(
  checks: Record<string, () => Promise<void>>,
  timeoutMs: number,
): Promise<Map<string, { up: boolean; seconds: number }>> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const started = performance.now();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      let up = true;
      try {
        await Promise.race([check(), timeout]);
      } catch {
        up = false;
      } finally {
        clearTimeout(timer);
      }
      return [name, { up, seconds: (performance.now() - started) / 1000 }] as const;
    }),
  );
  return new Map(entries);
}
