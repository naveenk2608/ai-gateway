-- Up Migration

-- Rate, token and concurrency limits (ADR 008) per project and per key. NULL means no limit.
ALTER TABLE projects
  ADD COLUMN rpm_limit integer CHECK (rpm_limit > 0),
  ADD COLUMN tpm_limit integer CHECK (tpm_limit > 0),
  ADD COLUMN concurrency_limit integer CHECK (concurrency_limit > 0),
  -- Budget per UTC calendar month (ADR 009), and the most one request may reserve.
  ADD COLUMN monthly_budget_micro_usd bigint CHECK (monthly_budget_micro_usd >= 0),
  ADD COLUMN max_request_cost_micro_usd bigint CHECK (max_request_cost_micro_usd > 0);

ALTER TABLE api_keys
  ADD COLUMN rpm_limit integer CHECK (rpm_limit > 0),
  ADD COLUMN tpm_limit integer CHECK (tpm_limit > 0),
  ADD COLUMN concurrency_limit integer CHECK (concurrency_limit > 0);

-- budget_periods is the monthly spend ledger of every project, kept by the worker in the same
-- transaction as each usage row. It is what the gateway rebuilds its Redis totals from.
-- limit_micro_usd is the budget the gateway last reported for the month; NULL when none was set.
ALTER TABLE budget_periods ALTER COLUMN limit_micro_usd DROP NOT NULL;

-- The gateway's prompt estimate before the call, kept to measure it against reported usage.
ALTER TABLE usage_events
  ADD COLUMN estimated_prompt_tokens integer CHECK (estimated_prompt_tokens >= 0);

-- Down Migration

ALTER TABLE usage_events DROP COLUMN estimated_prompt_tokens;
UPDATE budget_periods SET limit_micro_usd = 0 WHERE limit_micro_usd IS NULL;
ALTER TABLE budget_periods ALTER COLUMN limit_micro_usd SET NOT NULL;
ALTER TABLE api_keys
  DROP COLUMN rpm_limit,
  DROP COLUMN tpm_limit,
  DROP COLUMN concurrency_limit;
ALTER TABLE projects
  DROP COLUMN rpm_limit,
  DROP COLUMN tpm_limit,
  DROP COLUMN concurrency_limit,
  DROP COLUMN monthly_budget_micro_usd,
  DROP COLUMN max_request_cost_micro_usd;
