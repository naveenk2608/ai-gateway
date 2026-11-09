-- Up Migration

-- Routing edited from the dashboard (M15, ADR 034). Roles are per project, so overrides are per
-- project: a project admin may change a models-file route's policy and targets (order, weights,
-- last resort), using only deployments that route lists. Every change is a new version holding
-- the whole route; a rollback is a new version copying an old one; a reset is a new version with
-- no route (the file's route applies again). The active override is the highest version.
-- The older `routing_policies` table (0001) is not used: routing comes from the models file.
CREATE TABLE route_overrides (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 256),
  version integer NOT NULL CHECK (version >= 1),
  action text NOT NULL CHECK (action IN ('change', 'rollback', 'reset')),
  -- {"policy": ..., "targets": [{"deployment", "weight", "lastResort"}]}; null: the file's route.
  route jsonb,
  -- For a rollback: the version it copied.
  rolled_back_to integer,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_overrides_version UNIQUE (project_id, model, version),
  CONSTRAINT route_overrides_rollback CHECK ((action = 'rollback') = (rolled_back_to IS NOT NULL)),
  CONSTRAINT route_overrides_reset CHECK (action <> 'reset' OR route IS NULL)
);

-- Down Migration

DROP TABLE route_overrides;
