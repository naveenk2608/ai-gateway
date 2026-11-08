import type { RoutingPolicy } from '../models-config.js';
import type { PriceBook } from '../limits/prices.js';
import type { Deployment, Route } from '../providers/registry.js';
import type { LatencyMode, PeakEwma, Score } from './peak-ewma.js';

/**
 * Exponentially weighted moving average of each deployment's time to the start of a response
 * (the whole response when not streaming, the first token when streaming), on this instance.
 */
export class LatencyTracker {
  readonly #alpha: number;
  readonly #ewma = new Map<string, number>();

  constructor(alpha = 0.3) {
    this.#alpha = alpha;
  }

  record(deployment: string, ms: number): void {
    const previous = this.#ewma.get(deployment);
    this.#ewma.set(
      deployment,
      previous === undefined ? ms : this.#alpha * ms + (1 - this.#alpha) * previous,
    );
  }

  get(deployment: string): number | undefined {
    return this.#ewma.get(deployment);
  }
}

export interface Candidate {
  deployment: Deployment;
  /** Why it is at this place in the order, stored on its attempt. */
  reason: string;
}

export interface PlanContext {
  latency: LatencyTracker;
  /**
   * Latency estimates and tries in flight for `peak_ewma` (ADR 030). Absent or switched off,
   * `peak_ewma` routes are ordered as `lowest_latency`.
   */
  peakEwma?: PeakEwma | undefined;
  /** Whether the request streams: `peak_ewma` scores it with the time to first token. */
  stream?: boolean | undefined;
  prices: PriceBook;
  /** A number in [0, 1); injected so weighted and peak_ewma picks are repeatable in tests. */
  random: () => number;
  at: number;
  promptTokens: number;
  maxTokens: number;
  /**
   * The project's budget use in percent, set when it is at or above its soft threshold: the
   * deployments are then tried cheapest first, whatever the route's policy (M11).
   */
  cheapestFirstAt?: number | undefined;
}

/** Picks one target with probability proportional to its weight. */
function weightedPick<T extends { weight: number }>(items: T[], random: () => number): number {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let point = random() * total;
  for (let i = 0; i < items.length; i++) {
    point -= items[i]!.weight;
    if (point < 0) return i;
  }
  return items.length - 1;
}

/**
 * The order in which a request tries a model's deployments, with the reason for each place. The
 * first is the policy's choice; the rest are fallbacks if it fails (ADR 011). Circuit breakers are
 * applied when each attempt starts, since they can change during a request.
 */
export function planRoute(route: Route, ctx: PlanContext): Candidate[] {
  const last = route.targets.filter((t) => t.lastResort);
  const main = route.targets.filter((t) => !t.lastResort);
  const budgetPct = ctx.cheapestFirstAt;
  return [
    ...(budgetPct === undefined
      ? orderByPolicy(route.policy, main, ctx)
      : orderByPolicy('cost_aware', main, ctx).map((c) => ({
          deployment: c.deployment,
          reason: `budget at ${budgetPct}%: cheapest first; ${c.reason}`,
        }))),
    ...last.map((t, i) => ({
      deployment: t.deployment,
      reason: `last resort ${i + 1} of ${last.length}`,
    })),
  ];
}

function orderByPolicy(
  policy: RoutingPolicy,
  targets: Route['targets'],
  ctx: PlanContext,
): Candidate[] {
  if (targets.length === 0) return [];
  switch (policy) {
    case 'priority':
      return targets.map((t, i) => ({
        deployment: t.deployment,
        reason: `priority ${i + 1} of ${targets.length}`,
      }));
    case 'weighted': {
      const remaining = [...targets];
      const total = remaining.reduce((sum, t) => sum + t.weight, 0);
      const order: Candidate[] = [];
      while (remaining.length > 0) {
        const [picked] = remaining.splice(weightedPick(remaining, ctx.random), 1);
        order.push({
          deployment: picked!.deployment,
          reason:
            order.length === 0
              ? `weighted pick (weight ${picked!.weight} of ${total})`
              : `weighted fallback (weight ${picked!.weight})`,
        });
      }
      return order;
    }
    case 'peak_ewma': {
      const tracker = ctx.peakEwma;
      if (!tracker?.enabled) {
        return orderByPolicy('lowest_latency', targets, ctx).map((c) => ({
          deployment: c.deployment,
          reason: `peak_ewma off: ${c.reason}`,
        }));
      }
      return peakEwmaOrder(targets, tracker, ctx.stream === true ? 'stream' : 'plain', ctx.random);
    }
    case 'lowest_latency': {
      // Unmeasured deployments go first, so each gets measured.
      const scored = targets.map((t, i) => ({ t, i, ms: ctx.latency.get(t.deployment.id) }));
      scored.sort((a, b) => (a.ms ?? -1) - (b.ms ?? -1) || a.i - b.i);
      return scored.map(({ t, ms }, rank) => ({
        deployment: t.deployment,
        reason:
          ms === undefined
            ? 'lowest latency: not measured yet'
            : `${rank === 0 ? 'lowest latency' : `latency rank ${rank + 1}`}: EWMA ${Math.round(ms)} ms`,
      }));
    }
    case 'cost_aware': {
      const scored = targets.map((t, i) => ({
        t,
        i,
        cost: ctx.prices.cost(
          t.deployment.providerName,
          t.deployment.providerModel,
          ctx.at,
          ctx.promptTokens,
          ctx.maxTokens,
        ),
      }));
      scored.sort((a, b) => a.cost - b.cost || a.i - b.i);
      return scored.map(({ t, cost }, rank) => ({
        deployment: t.deployment,
        reason: `${rank === 0 ? 'cheapest' : `cost rank ${rank + 1}`}: at most ${cost} micro-USD`,
      }));
    }
  }
}

/** A score as stored in the routing reason: `a 240 (120 ms x 2)`, with where the estimate came from. */
function describeScore(id: string, s: Score): string {
  const ms = Math.round(s.estimateMs).toLocaleString('en-US');
  const estimate =
    s.source === 'default'
      ? `no estimate yet, default ${ms} ms`
      : s.source === 'stream'
        ? `${ms} ms to first token`
        : `${ms} ms`;
  return `${id} ${Math.round(s.score).toLocaleString('en-US')} (${estimate} x ${s.inFlight} in flight + 1)`;
}

/**
 * Power of two choices over peak EWMA scores (ADR 030): two different deployments picked at
 * random, the lower score first (the first picked on a tie), then every other one by score, so
 * the fallbacks are the next best. Scoring decays each estimate it reads (PeakEwma.score).
 */
function peakEwmaOrder(
  targets: Route['targets'],
  tracker: PeakEwma,
  mode: LatencyMode,
  random: () => number,
): Candidate[] {
  const scored = targets.map((t, i) => ({ t, i, s: tracker.score(t.deployment.id, mode) }));
  if (scored.length === 1) {
    const only = scored[0]!;
    return [
      {
        deployment: only.t.deployment,
        reason: `peak EWMA: only choice, ${describeScore(only.t.deployment.id, only.s)}`,
      },
    ];
  }
  const n = scored.length;
  const first = Math.min(n - 1, Math.floor(random() * n));
  let second = Math.min(n - 2, Math.floor(random() * (n - 1)));
  if (second >= first) second++;
  const a = scored[first]!;
  const b = scored[second]!;
  const [winner, loser] = b.s.score < a.s.score ? [b, a] : [a, b];
  const rest = scored
    .filter((x) => x !== winner)
    .sort((x, y) => x.s.score - y.s.score || x.i - y.i);
  return [
    {
      deployment: winner.t.deployment,
      reason:
        `peak EWMA: picked ${describeScore(winner.t.deployment.id, winner.s)} over ` +
        describeScore(loser.t.deployment.id, loser.s),
    },
    ...rest.map((x, rank) => ({
      deployment: x.t.deployment,
      reason: `peak EWMA fallback ${rank + 1}: ${describeScore(x.t.deployment.id, x.s)}`,
    })),
  ];
}
