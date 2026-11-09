-- Up Migration

-- Idempotency-Key (M15, ADR 032): a key a client sends with POST /v1/chat/completions or
-- /v1/embeddings, so a retry is answered with the first request's answer instead of a second call.
-- A key belongs to one project and one endpoint. The first request inserts its row `in_progress`
-- (the unique constraint makes that atomic across instances), holding a lock until `locked_until`;
-- a 2xx answer is stored with the status and the headers a replay needs, and `response` is the
-- answer itself (null when it was larger than the cap); a failure deletes the row. Rows expire at
-- `expires_at` and the worker deletes them.
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (endpoint IN ('chat', 'embeddings')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  -- SHA-256 (hex) of the request body without stream, stream_options and user.
  fingerprint text NOT NULL CHECK (char_length(fingerprint) = 64),
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  -- The request that ran (or runs) it, and the gateway instance holding the lock.
  request_id uuid NOT NULL,
  owner text NOT NULL,
  locked_until timestamptz NOT NULL,
  response_status smallint,
  response_headers jsonb,
  response jsonb,
  response_bytes integer CHECK (response_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_scope UNIQUE (project_id, endpoint, idempotency_key),
  CONSTRAINT idempotency_keys_completed CHECK (
    (status = 'completed') = (completed_at IS NOT NULL AND response_status IS NOT NULL)
  )
);

CREATE INDEX idempotency_keys_expires_at ON idempotency_keys (expires_at);

-- A request answered with the stored answer of an earlier request with the same Idempotency-Key:
-- no provider attempt and no cost, like a cache hit. A constant default adds the column without
-- rewriting the table, and a worker that predates it writes none.
ALTER TABLE request_records
  ADD COLUMN replayed boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE request_records DROP COLUMN replayed;
DROP TABLE idempotency_keys;
