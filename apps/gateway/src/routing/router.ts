import type { RoutingPolicy } from '../models-config.js';
import type { PriceBook } from '../limits/prices.js';
import type { Deployment, Route } from '../providers/registry.js';

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
  prices: PriceBook;
  /** A number in [0, 1); injected so weighted picks are repeatable in tests. */
  random: () => number;
  at: number;
  promptTokens: number;
  maxTokens: number;
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
  const targets = route.targets;
  const policy: RoutingPolicy = route.policy;
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
          t.deployment.provider.kind,
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
