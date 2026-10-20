import { budgetPeriodAt, type BudgetPeriod, type Clock } from '@ai-gateway/shared';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import type { ScopeLimits, UsagePolicy } from './policy.js';
import { ADMIT, INIT_BUDGET, RENEW, SETTLE, SWEEP } from './scripts.js';

export type LimitReason = 'rpm' | 'tpm' | 'concurrency' | 'budget';
export type LimitScope = 'key' | 'project';

export interface Rejection {
  reason: LimitReason;
  scope: LimitScope;
  /** When a retry can succeed; null when this request can never fit the limit. */
  retryAfterMs: number | null;
}

export interface AdmitRequest {
  requestId: string;
  projectId: string;
  apiKeyId: string;
  policy: UsagePolicy;
  /** Estimated prompt tokens plus the most the model may write. */
  tokens: number;
  /** The most this request can cost, reserved against the budget. */
  costMicroUsd: number;
  /** When the request started: picks its budget period, as the worker does. */
  startedAt: number;
}

export type Admission =
  { admitted: true; ticket: Ticket } | { admitted: false; rejection: Rejection };

/** Reads a project's recorded spend for a period from Postgres, to rebuild lost Redis totals. */
export type SpendLoader = (projectId: string, period: BudgetPeriod) => Promise<number>;

export interface LimiterOptions {
  redis: Redis;
  clock: Clock;
  logger: Logger;
  loadSpend: SpendLoader;
  /** How long a lease or reservation lives without renewal: how fast a crashed request frees it. */
  leaseTtlMs: number;
  /** Key prefix; tests use their own. */
  prefix?: string;
}

/** Budget totals outlive their month by this much, so late settlements still find them. */
const BUDGET_GRACE_MS = 7 * 24 * 3600 * 1000;

const limit = (value: number | null) => value ?? 0;

interface Keys {
  rpm: [string, string];
  tpm: [string, string];
  concurrency: [string, string];
  budget: string;
  reservations: string;
  open: string;
}

/**
 * Distributed limits and budgets (ADR 008, ADR 009) over Redis. Every check for a request runs
 * in one script, so concurrent requests on any number of instances see one consistent state, and
 * a rejected request takes nothing. Redis errors are thrown; the caller applies the fail mode
 * (ADR 010).
 */
export class Limiter {
  readonly #o: LimiterOptions;
  readonly #prefix: string;

  constructor(options: LimiterOptions) {
    this.#o = options;
    this.#prefix = options.prefix ?? 'gw:';
  }

  get leaseTtlMs(): number {
    return this.#o.leaseTtlMs;
  }

  #keys(projectId: string, apiKeyId: string, period: BudgetPeriod): Keys {
    const p = this.#prefix;
    const budget = `${p}budget:${projectId}:${period.key}`;
    return {
      rpm: [`${p}rl:rpm:key:${apiKeyId}`, `${p}rl:rpm:project:${projectId}`],
      tpm: [`${p}rl:tpm:key:${apiKeyId}`, `${p}rl:tpm:project:${projectId}`],
      concurrency: [`${p}rl:conc:key:${apiKeyId}`, `${p}rl:conc:project:${projectId}`],
      budget,
      reservations: `${budget}:res`,
      open: `${p}budget:open`,
    };
  }

  async admit(request: AdmitRequest): Promise<Admission> {
    const { policy } = request;
    const now = this.#o.clock.now();
    const period = budgetPeriodAt(request.startedAt);
    const keys = this.#keys(request.projectId, request.apiKeyId, period);
    const budgeted = policy.monthlyBudgetMicroUsd !== null;
    const openMember = `${request.projectId}|${period.key}|${request.requestId}`;
    const budgetTtlMs = period.end - now + BUDGET_GRACE_MS;
    const run = () =>
      ADMIT.run(
        this.#o.redis,
        [...keys.rpm, ...keys.tpm, ...keys.concurrency, keys.budget, keys.reservations, keys.open],
        [
          now,
          limit(policy.key.rpm),
          limit(policy.project.rpm),
          limit(policy.key.tpm),
          limit(policy.project.tpm),
          request.tokens,
          limit(policy.key.concurrency),
          limit(policy.project.concurrency),
          request.requestId,
          now + this.#o.leaseTtlMs,
          policy.monthlyBudgetMicroUsd ?? -1,
          request.costMicroUsd,
          openMember,
          budgetTtlMs,
          period.end,
          this.#o.leaseTtlMs * 2,
        ],
      );

    let reply = (await run()) as unknown[];
    if (reply[0] === -1) {
      // No totals for this month: its first request, or Redis lost its data. Rebuild them from
      // the spend Postgres recorded rather than starting again from zero.
      const spent = await this.#o.loadSpend(request.projectId, period);
      const created = await INIT_BUDGET.run(this.#o.redis, [keys.budget], [spent, budgetTtlMs]);
      if (created === 1) {
        this.#o.logger.info(
          { projectId: request.projectId, period: period.key, spentMicroUsd: spent },
          'budget totals rebuilt from Postgres',
        );
      }
      reply = (await run()) as unknown[];
    }
    if (reply[0] !== 1) {
      const retryAfterMs = Number(reply[3]);
      return {
        admitted: false,
        rejection: {
          reason: reply[1] as LimitReason,
          scope: reply[2] as LimitScope,
          retryAfterMs: retryAfterMs < 0 ? null : retryAfterMs,
        },
      };
    }
    const ticket = new Ticket(this.#o, {
      keys,
      leaseId: request.requestId,
      openMember,
      tokens: request.tokens,
      tpm: [policy.key.tpm, policy.project.tpm],
      concurrency: [policy.key, policy.project],
      budgeted,
    });
    return { admitted: true, ticket };
  }

  /**
   * Releases reservations whose request stopped renewing them, and returns them for auditing.
   * Each is returned to exactly one caller, even with several instances sweeping.
   */
  async sweep(max = 100): Promise<ExpiredReservation[]> {
    const reply = (await SWEEP.run(
      this.#o.redis,
      [`${this.#prefix}budget:open`],
      [this.#o.clock.now(), max, `${this.#prefix}budget:`],
    )) as string[];
    const expired: ExpiredReservation[] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) {
      const [projectId, period, requestId] = reply[i]!.split('|');
      if (!projectId || !period || !requestId) continue;
      expired.push({ projectId, period, requestId, amountMicroUsd: Number(reply[i + 1]) });
    }
    return expired;
  }
}

export interface ExpiredReservation {
  projectId: string;
  /** `YYYY-MM` */
  period: string;
  requestId: string;
  amountMicroUsd: number;
}

interface TicketState {
  keys: Keys;
  leaseId: string;
  openMember: string;
  tokens: number;
  tpm: [number | null, number | null];
  concurrency: [ScopeLimits, ScopeLimits];
  budgeted: boolean;
}

export interface Actual {
  /** Tokens actually used (reported or estimated); the TPM reservation is corrected to it. */
  tokens: number;
  costMicroUsd: number;
}

/**
 * What an admitted request holds: concurrency leases, TPM tokens and a budget reservation. While
 * it runs, `keepAlive` renews the leases; `settle` gives back what was not used, exactly once.
 */
export class Ticket {
  readonly #o: LimiterOptions;
  readonly #s: TicketState;
  readonly #stop = new AbortController();
  #settled = false;

  constructor(options: LimiterOptions, state: TicketState) {
    this.#o = options;
    this.#s = state;
  }

  /** Whether anything needs renewing while the request runs. */
  get holdsLeases(): boolean {
    const [key, project] = this.#s.concurrency;
    return key.concurrency !== null || project.concurrency !== null || this.#s.budgeted;
  }

  /** Renews the leases every third of their TTL until settle() is called. */
  keepAlive(): void {
    if (!this.holdsLeases) return;
    const every = Math.max(1, Math.floor(this.#o.leaseTtlMs / 3));
    void (async () => {
      while (!this.#stop.signal.aborted) {
        try {
          await this.#o.clock.sleep(every, this.#stop.signal);
        } catch {
          return;
        }
        await this.renew().catch((err: unknown) => {
          this.#o.logger.warn({ err }, 'lease renewal failed');
        });
      }
    })();
  }

  async renew(): Promise<void> {
    const { keys } = this.#s;
    await RENEW.run(
      this.#o.redis,
      [...keys.concurrency, keys.open],
      [
        this.#s.leaseId,
        this.#o.clock.now() + this.#o.leaseTtlMs,
        this.#s.openMember,
        this.#o.leaseTtlMs * 2,
      ],
    );
  }

  /**
   * Gives back what the request did not use and charges what it did. Returns whether the cost
   * reached the Redis budget totals. Only the first call does anything.
   */
  async settle(actual: Actual): Promise<boolean> {
    if (this.#settled) return false;
    this.#settled = true;
    this.#stop.abort();
    const { keys, tpm } = this.#s;
    const charged = await SETTLE.run(
      this.#o.redis,
      [...keys.tpm, ...keys.concurrency, keys.budget, keys.reservations, keys.open],
      [
        this.#o.clock.now(),
        limit(tpm[0]),
        limit(tpm[1]),
        this.#s.tokens,
        actual.tokens,
        this.#s.leaseId,
        actual.costMicroUsd,
        this.#s.openMember,
        this.#s.budgeted ? '1' : '0',
      ],
    );
    return charged === 1;
  }

  /** Stops renewing without releasing anything, as a crashed instance would. Tests only. */
  abandon(): void {
    this.#settled = true;
    this.#stop.abort();
  }
}
