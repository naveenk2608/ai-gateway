/** Limits on one scope, a key or a project (ADR 008). null means no limit. */
export interface ScopeLimits {
  /** Requests per minute. */
  rpm: number | null;
  /** Tokens per minute: estimated prompt plus max output, reconciled to actual usage. */
  tpm: number | null;
  /** Requests in flight at once. */
  concurrency: number | null;
}

/** What a caller may use: its key's limits, its project's limits and the project's budget. */
export interface UsagePolicy {
  key: ScopeLimits;
  project: ScopeLimits;
  /** Spend allowed per UTC calendar month, in micro-dollars (ADR 009); null means no budget. */
  monthlyBudgetMicroUsd: number | null;
  /** The most one request may reserve; null means no cap beyond the budget. */
  maxRequestCostMicroUsd: number | null;
}

export const NO_SCOPE_LIMITS: ScopeLimits = { rpm: null, tpm: null, concurrency: null };

export const UNLIMITED: UsagePolicy = {
  key: NO_SCOPE_LIMITS,
  project: NO_SCOPE_LIMITS,
  monthlyBudgetMicroUsd: null,
  maxRequestCostMicroUsd: null,
};

/** True when the policy sets anything that needs Redis to enforce. */
export function hasLimits(policy: UsagePolicy): boolean {
  const any = (s: ScopeLimits) => s.rpm !== null || s.tpm !== null || s.concurrency !== null;
  return any(policy.key) || any(policy.project) || policy.monthlyBudgetMicroUsd !== null;
}
