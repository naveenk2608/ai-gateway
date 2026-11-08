import type { Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger } from 'fastify';
import { GatewayError } from '../errors.js';
import type { PriceBook } from '../limits/prices.js';
import { ProviderError, type ProviderErrorKind } from '../providers/errors.js';
import type { Deployment, Route } from '../providers/registry.js';
import type { AttemptContext, AttemptOutcome } from '../proxy/attempt.js';
import type { RequestTrace } from '../proxy/trace.js';
import { countsAsFailure, type BreakerBoard } from './breaker.js';
import type { QuotaBoard, QuotaTicket } from './quota.js';
import type { PeakEwma } from './peak-ewma.js';
import { planRoute, type LatencyTracker } from './router.js';

export interface RetrySettings {
  /** Attempts per request, across all deployments. */
  maxAttempts: number;
  /** Attempts on one deployment before falling back to the next. */
  perDeployment: number;
  /** Backoff before retry n is a random wait in [0, min(maxDelayMs, baseDelayMs x 2^(n-1))). */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RoutingDeps {
  breakers: BreakerBoard;
  latency: LatencyTracker;
  /**
   * Peak EWMA estimates and tries in flight per deployment on this instance (ADR 030). Without it
   * (unit tests), `peak_ewma` routes are ordered as `lowest_latency`.
   */
  peakEwma?: PeakEwma | undefined;
  prices: PriceBook;
  retry: RetrySettings;
  /** A number in [0, 1), for weighted picks and backoff jitter. */
  random: () => number;
  /**
   * Free-tier quotas and 429 cooldowns shared through Redis (ADR 025). Without it (unit tests),
   * every deployment may always be tried.
   */
  quotas?: QuotaBoard | undefined;
  /**
   * The most a request may take until its response starts, counted from its arrival
   * (REQUEST_DEADLINE_MS): no try, retry or fallback starts after it, and a try still running is
   * cut at it. Without it (unit tests), only each deployment's timeout applies.
   */
  deadlineMs?: number | undefined;
}

export interface RoutedRequest {
  route: Route;
  trace: RequestTrace;
  clock: Clock;
  clientSignal: AbortSignal;
  log: FastifyBaseLogger;
  /** Whether the response streams: `peak_ewma` then scores time to first token. */
  stream?: boolean | undefined;
  /** For cost-aware ordering: the output cap the request may use. */
  maxTokens: number;
  /** The project's budget use at admission and its soft threshold, when it has a budget. */
  budget?: { usedShare: number; softThresholdPct: number } | undefined;
  /**
   * Deployments of the model left out because they cannot serve the request (ADR 028), e.g.
   * `x (no tools)`: named in the first try's reason, like breaker skips.
   */
  unfit?: readonly string[] | undefined;
}

/** The budget use in whole percent when it has reached the soft threshold; undefined otherwise. */
export function cheapestFirstAt(budget: RoutedRequest['budget']): number | undefined {
  if (!budget) return undefined;
  const pct = Math.floor(budget.usedShare * 100);
  return pct >= budget.softThresholdPct ? pct : undefined;
}

/** Failures another deployment might not have; a rejected request or a gone client do not. */
const FALLBACK: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout',
  'rate_limited',
  'server_error',
  'connection',
  'invalid_response',
  'auth',
  'not_found',
]);

/**
 * Runs `start` against the route's deployments (ADR 011, ADR 012): in the policy's order, skipping
 * deployments whose breaker is open, retrying a retryable failure on the same deployment after a
 * backoff with full jitter, then falling back to the next. `start` resolves once the response has
 * begun (for a stream, its first event), so nothing is retried after the first byte reaches the
 * client. Every attempt is recorded with the policy and the reason it was made.
 */
export async function runRouted<T>(
  deps: RoutingDeps,
  req: RoutedRequest,
  start: (ctx: AttemptContext) => Promise<T>,
): Promise<T> {
  const { route, clock, clientSignal } = req;
  const candidates = planRoute(route, {
    latency: deps.latency,
    peakEwma: deps.peakEwma,
    stream: req.stream,
    prices: deps.prices,
    random: deps.random,
    at: req.trace.startedAt,
    promptTokens: req.trace.estimatedPromptTokens,
    maxTokens: req.maxTokens,
    cheapestFirstAt: cheapestFirstAt(req.budget),
  });
  const { maxAttempts, perDeployment, baseDelayMs, maxDelayMs } = deps.retry;
  let attempts = 0;
  let lastError: ProviderError | undefined;
  /** The previous failure, named in the next deployment's reason. */
  let failed: { id: string; kind: ProviderErrorKind } | undefined;
  const skipped: string[] = [...(req.unfit ?? [])];
  /** Deployments left behind so far, for the answering attempt's `passedOver`. */
  const passedOver: string[] = [];
  /** Skips for a used-up quota or a 429 cooldown: the error when nothing could be tried. */
  const limited: { kind: 'quota' | 'cooldown'; retryAfterMs: number }[] = [];
  const promptTokens = req.trace.estimatedPromptTokens;
  const deadlineAt =
    deps.deadlineMs === undefined ? undefined : req.trace.startedAt + deps.deadlineMs;
  const timeLeft = () => (deadlineAt === undefined ? Infinity : deadlineAt - clock.now());
  /** Answered as 504 upstream_timeout, like any timeout. */
  const deadlinePassed = () =>
    new ProviderError('timeout', `the request's deadline of ${deps.deadlineMs} ms passed`);

  for (const candidate of candidates) {
    const id = candidate.deployment.id;
    const breaker = deps.breakers.get(id);
    let retryNote: string | undefined;
    for (let tryNumber = 1; tryNumber <= perDeployment && attempts < maxAttempts; tryNumber++) {
      if (timeLeft() <= 0) throw deadlinePassed();
      if (!breaker.tryAcquire()) {
        skipped.push(`${id} (circuit ${breaker.state})`);
        break;
      }
      let ticket: QuotaTicket | null = null;
      if (deps.quotas) {
        // A retry here follows this deployment's own failure and waited out its Retry-After,
        // so only the quota applies to it, not the cooldown its 429 may have started.
        const check = await deps.quotas.acquire(
          candidate.deployment,
          promptTokens + req.maxTokens,
          { ignoreCooldown: tryNumber > 1 },
        );
        if (!check.ok) {
          breaker.onNeutral();
          skipped.push(`${id} (${check.reason})`);
          limited.push({ kind: check.kind, retryAfterMs: check.retryAfterMs });
          break;
        }
        ticket = check.ticket;
      }
      const reason =
        retryNote ??
        [
          candidate.reason,
          ...(failed ? [`fallback after ${failed.id} failed (${failed.kind})`] : []),
          ...(skipped.length > 0 ? [`skipped ${skipped.join(', ')}`] : []),
        ].join('; ');
      skipped.length = 0;
      attempts++;
      // In flight from here until the try's response or stream ends, however it ends (ADR 030).
      deps.peakEwma?.begin(id);
      let inFlight = true;
      const landed = () => {
        if (!inFlight) return;
        inFlight = false;
        deps.peakEwma?.end(id);
      };
      const ctx: AttemptContext = {
        deployment: candidate.deployment,
        clock,
        clientSignal,
        log: req.log,
        trace: req.trace,
        routing: { policy: route.policy, reason },
        passedOver: [...passedOver],
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        onEnd: (outcome) => {
          landed();
          settleHealth(deps, candidate.deployment, outcome);
          settleQuota(deps, candidate.deployment, ticket, outcome, promptTokens);
        },
      };
      try {
        return await start(ctx);
      } catch (err) {
        // Normally the attempt ended already (onEnd); not if it failed before it began.
        landed();
        if (!(err instanceof ProviderError) || !FALLBACK.has(err.kind)) throw err;
        lastError = err;
        failed = { id, kind: err.kind };
        const retryAfter = err.retryAfterMs;
        const canRetryHere =
          err.retryable &&
          tryNumber < perDeployment &&
          attempts < maxAttempts &&
          (retryAfter === undefined || retryAfter <= maxDelayMs);
        if (!canRetryHere) break;
        const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (tryNumber - 1));
        const delay = Math.max(Math.floor(deps.random() * ceiling), retryAfter ?? 0);
        // No time left for the wait and a try after it.
        if (delay >= timeLeft()) throw deadlinePassed();
        retryNote = `retry ${tryNumber} on ${id} after ${err.kind}, waited ${delay} ms`;
        try {
          await clock.sleep(delay, clientSignal);
        } catch {
          throw new ProviderError('canceled', 'client closed the request during a retry wait');
        }
      }
    }
    // Reached only when this deployment did not answer: it failed, or its circuit was open.
    passedOver.push(id);
    if (attempts >= maxAttempts) break;
  }

  if (lastError !== undefined) throw lastError;
  if (limited.length > 0) {
    // Nothing was tried: free-tier quotas are used up or providers asked us to back off. The
    // client may retry when the first of them clears.
    const waitMs = Math.min(...limited.map((l) => l.retryAfterMs));
    const quota = limited.some((l) => l.kind === 'quota');
    throw new GatewayError(
      quota ? 'upstream_quota_exhausted' : 'upstream_rate_limited',
      quota
        ? `The free-tier quota of every deployment of \`${route.model}\` is used up; retry later.`
        : `Every deployment of \`${route.model}\` is rate limited by its provider; retry later.`,
      {
        httpStatus: 429,
        retryable: true,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      },
    );
  }
  // Every deployment's breaker is open: fail fast rather than call a deployment known to fail.
  const waitMs = Math.min(
    ...route.targets.map((t) => deps.breakers.get(t.deployment.id).retryInMs),
  );
  throw new GatewayError(
    'deployments_unavailable',
    `Every deployment of the model \`${route.model}\` is failing; retry shortly.`,
    { httpStatus: 503, retryable: true, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) },
  );
}

/**
 * Quota bookkeeping when an attempt ends (ADR 025): its counted tokens corrected to what it used,
 * the provider's own counts from its headers, and a cooldown after a 429.
 */
function settleQuota(
  deps: RoutingDeps,
  deployment: Deployment,
  ticket: QuotaTicket | null,
  outcome: AttemptOutcome,
  promptTokens: number,
): void {
  const quotas = deps.quotas;
  if (!quotas) return;
  quotas.settle(ticket, outcome.usage?.totalTokens ?? null, promptTokens);
  quotas.observe(deployment, outcome.rateLimit);
  if (outcome.error instanceof ProviderError && outcome.error.kind === 'rate_limited') {
    quotas.cooldown(deployment.id, outcome.error.retryAfterMs);
  }
}

/**
 * A try the request's deadline (REQUEST_DEADLINE_MS) cut before it had run for its deployment's
 * own `timeoutMs`: the time the request had left ran out, not the deployment's, so it says nothing
 * about the deployment's health or speed (ADR 012).
 */
export function cutShortByDeadline(deployment: Deployment, outcome: AttemptOutcome): boolean {
  return outcome.timeoutPhase === 'deadline' && outcome.latencyMs < deployment.timeoutMs;
}

/**
 * A try that waited its deployment's whole `timeoutMs` for its response (or first event): the
 * deployment was at least that slow, so `peak_ewma` records the timeout as its latency (ADR 030).
 * An idle timeout after the first event is not one: the first event did come.
 */
export function ranFullTimeout(deployment: Deployment, outcome: AttemptOutcome): boolean {
  const phase = outcome.timeoutPhase;
  if (phase === 'response' || phase === 'first_event') return true;
  return phase === 'deadline' && outcome.latencyMs >= deployment.timeoutMs;
}

function settleHealth(deps: RoutingDeps, deployment: Deployment, outcome: AttemptOutcome): void {
  const breaker = deps.breakers.get(deployment.id);
  const mode = outcome.stream === true ? 'stream' : 'plain';
  if (outcome.error === undefined) {
    breaker.onSuccess();
    deps.latency.record(deployment.id, outcome.ttftMs ?? outcome.latencyMs);
    deps.peakEwma?.record(deployment.id, mode, outcome.ttftMs ?? outcome.latencyMs);
  } else if (cutShortByDeadline(deployment, outcome)) {
    breaker.onNeutral();
  } else if (outcome.error instanceof ProviderError && countsAsFailure(outcome.error.kind)) {
    breaker.onFailure(outcome.error.kind);
    if (ranFullTimeout(deployment, outcome)) {
      deps.peakEwma?.record(deployment.id, mode, deployment.timeoutMs);
    }
  } else {
    breaker.onNeutral();
  }
}
