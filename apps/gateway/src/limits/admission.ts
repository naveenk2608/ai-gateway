import type { FastifyBaseLogger } from 'fastify';
import type { AuthenticatedKey } from '../auth/key-verifier.js';
import { GatewayError } from '../errors.js';
import type { Deployment } from '../providers/registry.js';
import type { RequestTrace } from '../proxy/trace.js';
import type { Limiter, Rejection, Ticket } from './limiter.js';
import { hasLimits, type ScopeLimits } from './policy.js';
import type { PriceBook } from './prices.js';

/** What happens when Redis cannot be reached (ADR 010). */
export type FailMode = 'closed' | 'open';

export interface AdmissionOptions {
  limiter: Pick<Limiter, 'admit'>;
  prices: PriceBook;
  failMode: FailMode;
}

export interface AdmitInput {
  key: AuthenticatedKey;
  trace: RequestTrace;
  /** Every deployment the request may be routed to; the worst case is the costliest. */
  deployments: readonly Deployment[];
  /** The client's max_tokens; each deployment otherwise uses its own maxOutputTokens. */
  clientMaxTokens: number | undefined;
  log: FastifyBaseLogger;
}

/** What admission took for one request; release it exactly once, when the request ends. */
export interface Settlement {
  /** Reserved TPM tokens: estimated prompt plus max output. */
  readonly tokens: number;
  /** Reserved budget: the most the request can cost (0 when the model has no price). */
  readonly costMicroUsd: number;
  /** Gives back what the request did not use. Never throws; failures are logged. */
  release(): void;
}

const SCOPE_NAMES = { key: 'API key', project: 'project' } as const;

const limitsUnavailable = new GatewayError(
  'limits_unavailable',
  'Rate limits cannot be checked right now. Retry shortly.',
  { httpStatus: 503, retryable: true, retryAfterSeconds: 1 },
);

function rejectionError(r: Rejection, input: AdmitInput, tokens: number): GatewayError {
  const scope = SCOPE_NAMES[r.scope];
  const limits: ScopeLimits = r.scope === 'key' ? input.key.policy.key : input.key.policy.project;
  if (r.retryAfterMs === null) {
    const message =
      r.reason === 'budget'
        ? "This request could cost more than the project's whole monthly budget. Lower max_tokens."
        : `This request needs about ${tokens} tokens, more than this ${scope}'s limit of ` +
          `${limits.tpm} tokens per minute. Lower max_tokens or shorten the prompt.`;
    return new GatewayError('request_exceeds_limit', message, {
      httpStatus: 400,
      param: 'max_tokens',
    });
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  const options = { httpStatus: 429, retryable: true, retryAfterSeconds };
  switch (r.reason) {
    case 'rpm':
      return new GatewayError(
        'rpm_limit_exceeded',
        `Rate limit reached: ${limits.rpm} requests per minute for this ${scope}.`,
        options,
      );
    case 'tpm':
      return new GatewayError(
        'tpm_limit_exceeded',
        `Token rate limit reached: ${limits.tpm} tokens per minute for this ${scope}.`,
        options,
      );
    case 'concurrency':
      return new GatewayError(
        'concurrency_limit_exceeded',
        `Too many requests in flight: this ${scope} allows ${limits.concurrency} at once.`,
        options,
      );
    case 'budget':
      return new GatewayError(
        'budget_exceeded',
        "The project's monthly budget is used up.",
        // Waiting for the next month is not a retry an SDK should make.
        { ...options, retryable: false },
      );
  }
}

const NOTHING_HELD = { tokens: 0, costMicroUsd: 0, release: () => undefined };

/**
 * Admission for /v1 requests: checks the key's and project's limits and the project's budget
 * before the provider is called (ADR 008, ADR 009), and settles them to actual usage after.
 */
export class AdmissionControl {
  readonly #o: AdmissionOptions;

  constructor(options: AdmissionOptions) {
    this.#o = options;
  }

  /** Admits the request or throws the GatewayError the client should see. */
  async admit(input: AdmitInput): Promise<Settlement> {
    const { key, trace, deployments, clientMaxTokens, log } = input;
    const { policy } = key;
    const maxTokensOf = (d: Deployment) => clientMaxTokens ?? d.maxOutputTokens;
    const tokens = trace.estimatedPromptTokens + Math.max(...deployments.map(maxTokensOf));
    // Retries and fallbacks run one at a time, so the worst case is the costliest deployment.
    const costMicroUsd = Math.max(
      ...deployments.map((d) =>
        this.#o.prices.cost(
          d.provider.kind,
          d.providerModel,
          trace.startedAt,
          trace.estimatedPromptTokens,
          maxTokensOf(d),
        ),
      ),
    );
    const priced = policy.monthlyBudgetMicroUsd !== null || policy.maxRequestCostMicroUsd !== null;
    if (!hasLimits(policy) && !priced) return NOTHING_HELD;

    let ticket: Ticket;
    try {
      // Without prices a budget would reserve nothing (Postgres was down at startup).
      if (priced && !this.#o.prices.loaded) throw new Error('model prices are not loaded yet');
      if (policy.maxRequestCostMicroUsd !== null && costMicroUsd > policy.maxRequestCostMicroUsd) {
        throw new GatewayError(
          'request_exceeds_limit',
          "This request could cost more than the project's limit per request. Lower max_tokens.",
          { httpStatus: 400, param: 'max_tokens' },
        );
      }
      if (!hasLimits(policy)) return NOTHING_HELD;
      const result = await this.#o.limiter.admit({
        requestId: trace.requestId,
        projectId: key.projectId,
        apiKeyId: key.apiKeyId,
        policy,
        tokens,
        costMicroUsd: policy.monthlyBudgetMicroUsd === null ? 0 : costMicroUsd,
        startedAt: trace.startedAt,
      });
      if (!result.admitted) {
        log.info({ ...result.rejection, tokens, costMicroUsd }, 'request rejected by limits');
        throw rejectionError(result.rejection, input, tokens);
      }
      ticket = result.ticket;
      if (policy.monthlyBudgetMicroUsd !== null) {
        trace.setBudget({
          limitMicroUsd: policy.monthlyBudgetMicroUsd,
          reservedMicroUsd: costMicroUsd,
        });
      }
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if (this.#o.failMode === 'closed') {
        log.error({ err }, 'limits unavailable; rejecting (LIMITS_FAIL_MODE=closed)');
        throw limitsUnavailable;
      }
      log.warn({ err }, 'limits unavailable; admitting without limits (LIMITS_FAIL_MODE=open)');
      return NOTHING_HELD;
    }

    ticket.keepAlive();
    let released = false;
    return {
      tokens,
      costMicroUsd,
      release: () => {
        if (released) return;
        released = true;
        void ticket.settle(this.#actual(trace)).catch((err: unknown) => {
          // Leases and reservations expire on their own; TPM tokens refill.
          log.warn({ err }, 'releasing limits failed');
        });
      },
    };
  }

  /** Tokens and cost the request used, from the same usage its event reports. */
  #actual(trace: RequestTrace) {
    const { usage } = trace.usage();
    const final = trace.attempts.at(-1);
    if (!usage || !final) {
      // No counts: a provider that failed still read the prompt.
      return { tokens: final ? trace.estimatedPromptTokens : 0, costMicroUsd: 0 };
    }
    return {
      tokens: usage.totalTokens,
      costMicroUsd: this.#o.prices.cost(
        final.provider,
        final.providerModel,
        trace.startedAt,
        usage.promptTokens,
        usage.completionTokens,
      ),
    };
  }
}
