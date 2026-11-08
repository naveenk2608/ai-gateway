import type { Clock } from '@ai-gateway/shared';

/** Which latency a try measures: time to first token (streams) or the whole response. */
export type LatencyMode = 'stream' | 'plain';

export interface PeakEwmaSettings {
  /** Off: `peak_ewma` routes are ordered as `lowest_latency` (PEAK_EWMA_ENABLED). */
  enabled: boolean;
  /** The decay's time constant in ms (PEAK_EWMA_DECAY_MS; Finagle's `decayTime`, 10 s). */
  decayMs: number;
  /** The estimate of a deployment with no sample yet, in ms (PEAK_EWMA_DEFAULT_MS; tower, 1 s). */
  defaultMs: number;
}

interface Estimate {
  ms: number;
  /** Clock time of the last update, for the decay. */
  at: number;
}

/** A deployment's score for one request: estimate x (tries in flight + 1). */
export interface Score {
  score: number;
  estimateMs: number;
  inFlight: number;
  /** Where the estimate came from: the request's mode, the other mode, or the default. */
  source: LatencyMode | 'default';
}

/**
 * Peak-sensitive moving averages of each deployment's latency on this instance, and its tries in
 * flight, for the `peak_ewma` policy (ADR 030). The update follows tower's `PeakEwma`: a sample
 * above the estimate replaces it at once; a lower one moves it toward the sample by
 * `1 - exp(-elapsed / decay)`; and reading an estimate for a score first decays it toward zero
 * for the time since its last update, so a deployment that was slow gets tried again later (its
 * next sample sets it back if it still is). Streamed and non-streamed latencies are kept apart.
 */
export class PeakEwma {
  readonly settings: PeakEwmaSettings;
  readonly #clock: Clock;
  readonly #estimates = new Map<string, Estimate>();
  /** The default estimate of a deployment with no sample, from the first time it was scored. */
  readonly #defaults = new Map<string, Estimate>();
  readonly #inFlight = new Map<string, number>();

  constructor(settings: PeakEwmaSettings, clock: Clock) {
    this.settings = settings;
    this.#clock = clock;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** A try to `deployment` started. */
  begin(deployment: string): void {
    this.#inFlight.set(deployment, (this.#inFlight.get(deployment) ?? 0) + 1);
  }

  /** A try to `deployment` ended (answered, failed or cancelled); call once per `begin`. */
  end(deployment: string): void {
    const n = (this.#inFlight.get(deployment) ?? 0) - 1;
    if (n > 0) this.#inFlight.set(deployment, n);
    else this.#inFlight.delete(deployment);
  }

  inFlight(deployment: string): number {
    return this.#inFlight.get(deployment) ?? 0;
  }

  /** Records a latency sample (tower's `RttEstimate::update`). */
  record(deployment: string, mode: LatencyMode, ms: number): void {
    const key = keyOf(deployment, mode);
    const now = this.#clock.now();
    const prior = this.#estimates.get(key);
    this.#defaults.delete(deployment);
    if (prior === undefined || prior.ms < ms) {
      this.#estimates.set(key, { ms, at: now });
      return;
    }
    const decay = Math.exp(-Math.max(0, now - prior.at) / this.settings.decayMs);
    this.#estimates.set(key, { ms: prior.ms * decay + ms * (1 - decay), at: now });
  }

  /**
   * The deployment's score for a request in `mode`, decaying the estimate it reads toward zero
   * first (tower's `PeakEwma::load`): the mode's own estimate, else the other mode's, else the
   * default, which also decays from the first time the deployment was scored.
   */
  score(deployment: string, mode: LatencyMode): Score {
    const now = this.#clock.now();
    const other: LatencyMode = mode === 'stream' ? 'plain' : 'stream';
    let source: Score['source'] = mode;
    let estimate = this.#estimates.get(keyOf(deployment, mode));
    if (estimate === undefined) {
      source = other;
      estimate = this.#estimates.get(keyOf(deployment, other));
    }
    if (estimate === undefined) {
      source = 'default';
      estimate = this.#defaults.get(deployment);
      if (estimate === undefined) {
        estimate = { ms: this.settings.defaultMs, at: now };
        this.#defaults.set(deployment, estimate);
      }
    }
    estimate.ms *= Math.exp(-Math.max(0, now - estimate.at) / this.settings.decayMs);
    estimate.at = now;
    const inFlight = this.inFlight(deployment);
    return { score: estimate.ms * (inFlight + 1), estimateMs: estimate.ms, inFlight, source };
  }

  /** Each measured estimate as it would read now, without changing it: for metrics. */
  estimates(): { deployment: string; mode: LatencyMode; ms: number }[] {
    const now = this.#clock.now();
    return [...this.#estimates].map(([key, e]) => {
      const [deployment, mode] = splitKey(key);
      const ms = e.ms * Math.exp(-Math.max(0, now - e.at) / this.settings.decayMs);
      return { deployment, mode, ms };
    });
  }
}

const keyOf = (deployment: string, mode: LatencyMode) => `${mode}:${deployment}`;

function splitKey(key: string): [string, LatencyMode] {
  const at = key.indexOf(':');
  return [key.slice(at + 1), key.slice(0, at) as LatencyMode];
}
