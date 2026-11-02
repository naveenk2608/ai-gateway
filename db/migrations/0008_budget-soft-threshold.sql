-- Up Migration

-- Soft budget threshold (M11): from this share of the monthly budget on, routing puts the
-- cheapest deployments first. At 100% requests are refused as before (ADR 009).
ALTER TABLE projects
  ADD COLUMN budget_soft_threshold_pct smallint NOT NULL DEFAULT 80
    CHECK (budget_soft_threshold_pct BETWEEN 1 AND 100);

-- Down Migration

ALTER TABLE projects DROP COLUMN budget_soft_threshold_pct;
