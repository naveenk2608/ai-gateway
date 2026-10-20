import type { Clock } from '@ai-gateway/shared';
import type { ProviderErrorKind } from '../providers/errors.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerSettings {
  /** Consecutive failures that open the breaker. */
  failureThreshold: number;
  /** How long an open breaker waits before letting a trial request through. */
  openMs: number;
}

export interface Transition {
  deployment: string;
  from: BreakerState;
  to: BreakerState;
  reason: string;
  at: number;
}

/**
 * Failures that say the deployment is unhealthy. A rejected request (bad_request) or a client
 * that left (canceled) says nothing about it.
 */
const UNHEALTHY: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout',
  'rate_limited',
  'server_error',
  'connection',
  'invalid_response',
  'auth',
  'not_found',
]);

export function countsAsFailure(kind: ProviderErrorKind): boolean {
  return UNHEALTHY.has(kind);
}

/**
 * One deployment's breaker on this instance (ADR 012): closed until `failureThreshold`
 * consecutive failures, then open (requests skip the deployment). After `openMs`, or as soon as an
 * active health check passes, it is half-open: one trial request at a time; its success closes the
 * breaker, its failure opens it again.
 */
export class CircuitBreaker {
  readonly deployment: string;
  readonly #settings: BreakerSettings;
  readonly #clock: Clock;
  readonly #onTransition: (t: Transition) => void;
  #state: BreakerState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #trialInFlight = false;

  constructor(
    deployment: string,
    settings: BreakerSettings,
    clock: Clock,
    onTransition: (t: Transition) => void,
  ) {
    this.deployment = deployment;
    this.#settings = settings;
    this.#clock = clock;
    this.#onTransition = onTransition;
  }

  /** The current state; an open breaker whose wait has passed is half-open. */
  get state(): BreakerState {
    if (this.#state === 'open' && this.#clock.now() >= this.#openedAt + this.#settings.openMs) {
      this.#move('half_open', `no trial for ${this.#settings.openMs} ms`);
    }
    return this.#state;
  }

  /** Milliseconds until an open breaker allows a trial; 0 otherwise. */
  get retryInMs(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.#openedAt + this.#settings.openMs - this.#clock.now());
  }

  /** Whether a request may use the deployment now. A half-open breaker admits one trial. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.#trialInFlight) return false;
    this.#trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.#failures = 0;
    if (this.#state === 'half_open') this.#move('closed', 'trial request succeeded');
    this.#trialInFlight = false;
  }

  onFailure(kind: ProviderErrorKind): void {
    if (this.#state === 'half_open') {
      this.#open(`trial request failed (${kind})`);
    } else if (this.#state === 'closed') {
      this.#failures++;
      if (this.#failures >= this.#settings.failureThreshold) {
        this.#open(`${this.#failures} consecutive failures (last: ${kind})`);
      }
    }
    this.#trialInFlight = false;
  }

  /** An attempt that ended without saying anything about health (e.g. the client left). */
  onNeutral(): void {
    this.#trialInFlight = false;
  }

  /** An active health check passed: let a trial request through now. */
  probeSucceeded(): void {
    if (this.#state === 'open') this.#move('half_open', 'health check passed');
  }

  #open(reason: string): void {
    this.#openedAt = this.#clock.now();
    this.#failures = 0;
    this.#move('open', reason);
  }

  #move(to: BreakerState, reason: string): void {
    const from = this.#state;
    this.#state = to;
    this.#onTransition({ deployment: this.deployment, from, to, reason, at: this.#clock.now() });
  }
}

/** The breakers of every deployment on this instance. */
export class BreakerBoard {
  readonly #breakers = new Map<string, CircuitBreaker>();

  constructor(
    deployments: readonly string[],
    settings: BreakerSettings,
    clock: Clock,
    onTransition: (t: Transition) => void,
  ) {
    for (const id of deployments) {
      this.#breakers.set(id, new CircuitBreaker(id, settings, clock, onTransition));
    }
  }

  get(deployment: string): CircuitBreaker {
    const breaker = this.#breakers.get(deployment);
    if (!breaker) throw new Error(`no breaker for deployment ${deployment}`);
    return breaker;
  }

  all(): CircuitBreaker[] {
    return [...this.#breakers.values()];
  }
}
