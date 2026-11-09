-- Up Migration

-- Guardrails (M16, ADR 035). A project's checks before and after the model, set by its admins on
-- the Security page; `{}` is "no checks", so every project starts with none. The policy is loaded
-- with the API key, like the allow-list.
ALTER TABLE projects
  ADD COLUMN guardrails jsonb NOT NULL DEFAULT '{}'::jsonb;

-- What each request's checks found and did: a type and a count, never a value. `check` is a
-- detector type (email, phone, card, aadhaar, pan), blocked_terms, prompt_size, schema or image.
CREATE TABLE guardrail_results (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('input', 'output')),
  "check" text NOT NULL CHECK (char_length("check") BETWEEN 1 AND 40),
  findings integer NOT NULL CHECK (findings >= 0),
  action text NOT NULL CHECK (action IN ('mask', 'block', 'flag', 'retry', 'fail', 'none')),
  created_at timestamptz NOT NULL,
  CONSTRAINT guardrail_results_once UNIQUE (request_id, stage, "check", action)
);

CREATE INDEX guardrail_results_project_time ON guardrail_results (project_id, created_at DESC);

-- Down Migration

DROP TABLE guardrail_results;
ALTER TABLE projects DROP COLUMN guardrails;
