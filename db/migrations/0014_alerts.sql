-- Up Migration

-- Webhook alerts (M15, ADR 033). A project admin adds destinations: a name, a kind (Discord,
-- Slack, or generic JSON signed with HMAC-SHA256), the URL and the events it gets. The URL (it
-- holds the receiver's token) and a generic destination's signing secret are stored encrypted with
-- AES-256-GCM (12-byte nonce, ciphertext, 16-byte tag); only a masked hint of the URL is kept in
-- clear.
CREATE TABLE alert_destinations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('discord', 'slack', 'generic')),
  url_ciphertext bytea NOT NULL,
  url_hint text NOT NULL,
  secret_ciphertext bytea,
  events text[] NOT NULL CHECK (
    cardinality(events) BETWEEN 1 AND 3
    AND events <@ ARRAY['budget', 'breaker', 'dead_letters']::text[]
  ),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alert_destinations_name UNIQUE (project_id, name),
  CONSTRAINT alert_destinations_secret CHECK ((kind = 'generic') = (secret_ciphertext IS NOT NULL))
);

-- The outbox: the process that detects an event inserts one row per destination, deduplicated by
-- (destination, dedupe_key); the worker sends due rows, retrying with backoff, until delivered or
-- failed. `last_error` never holds the URL.
CREATE TABLE alert_deliveries (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL REFERENCES alert_destinations (id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN ('budget.threshold', 'breaker.opened', 'dead_letters.growing', 'test')
  ),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text CHECK (char_length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT alert_deliveries_dedupe UNIQUE (destination_id, dedupe_key)
);

CREATE INDEX alert_deliveries_due ON alert_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX alert_deliveries_recent ON alert_deliveries (project_id, created_at DESC);

-- Down Migration

DROP TABLE alert_deliveries;
DROP TABLE alert_destinations;
