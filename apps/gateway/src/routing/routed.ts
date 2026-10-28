import type { Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger } from 'fastify';
import { GatewayError } from '../errors.js';
import type { PriceBook } from '../limits/prices.js';
import { ProviderError, type ProviderErrorKind } from '../providers/errors.js';
import type { Route } from '../providers/registry.js';
import type { AttemptContext, AttemptOutcome } from '../proxy/attempt.js';
import type { RequestTrace } from '../proxy/trace.js';
import { countsAsFailure, type BreakerBoard } from './breaker.js';
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
  prices: PriceBook;
  retry: RetrySettings;
  /** A number in [0, 1), for weighted picks and backoff jitter. */
  random: () => number;
}

export interface RoutedRequest {
  route: Route;
  trace: RequestTrace;
  clock: Clock;
  clientSignal: AbortSignal;
  log: FastifyBaseLogger;
  /** For cost-aware ordering: the output cap the request may use. */
  maxTokens: number;
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
    prices: deps.prices,
    random: deps.random,
    at: req.trace.startedAt,
    promptTokens: req.trace.estimatedPromptTokens,
    maxTokens: req.maxTokens,
  });
  const { maxAttempts, perDeployment, baseDelayMs, maxDelayMs } = deps.retry;
  let attempts = 0;
  let lastError: ProviderError | undefined;
  /** The previous failure, named in the next deployment's reason. */
  let failed: { id: string; kind: ProviderErrorKind } | undefined;
  const skipped: string[] = [];
  /** Deployments left behind so far, for the answering attempt's `passedOver`. */
  const passedOver: string[] = [];

  for (const candidate of candidates) {
    const id = candidate.deployment.id;
    const breaker = deps.breakers.get(id);
    let retryNote: string | undefined;
    for (let tryNumber = 1; tryNumber <= perDeployment && attempts < maxAttempts; tryNumber++) {
      if (!breaker.tryAcquire()) {
        skipped.push(`${id} (circuit ${breaker.state})`);
        break;
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
      const ctx: AttemptContext = {
        deployment: candidate.deployment,
        clock,
        clientSignal,
        log: req.log,
        trace: req.trace,
        routing: { policy: route.policy, reason },
        passedOver: [...passedOver],
        onEnd: (outcome) => settleHealth(deps, id, outcome),
      };
      try {
        return await start(ctx);
      } catch (err) {
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

function settleHealth(deps: RoutingDeps, deployment: string, outcome: AttemptOutcome): void {
  const breaker = deps.breakers.get(deployment);
  if (outcome.error === undefined) {
    breaker.onSuccess();
    deps.latency.record(deployment, outcome.ttftMs ?? outcome.latencyMs);
  } else if (outcome.error instanceof ProviderError && countsAsFailure(outcome.error.kind)) {
    breaker.onFailure(outcome.error.kind);
  } else {
    breaker.onNeutral();
  }
}
