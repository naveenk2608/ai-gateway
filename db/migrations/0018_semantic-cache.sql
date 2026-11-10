-- Up Migration

-- Semantic cache (M18, ADR 040). Vectors live in Postgres with pgvector, never in Redis. Neon
-- offers pgvector on every plan (neon.com/docs/extensions/pgvector, checked 2026-11-10). On a
-- server without it, or a role that may not create it, this migration still succeeds: the
-- entries table is not created and the gateway reports the semantic cache as unavailable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'pgvector is installed but this role may not create it: no semantic cache';
    END;
  END IF;
END
$$;

-- One stored answer per row: the vector of the request's last user message, a SHA-256 of
-- everything else in the request (which must match exactly), the answer and who made it (for the
-- cost a hit avoids). No prompt text is stored. The vector has no fixed size, since it depends on
-- the embedding model, which is part of the context key; so there is no vector index, and each
-- project's row cap bounds the scan.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE $sql$
      CREATE TABLE semantic_cache_entries (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        model text NOT NULL,
        context_key text NOT NULL CHECK (char_length(context_key) = 64),
        embedding vector NOT NULL,
        answer jsonb NOT NULL,
        provider text,
        provider_model text,
        billing text CHECK (billing IN ('free_tier', 'paid')),
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL
      )
    $sql$;
    EXECUTE 'CREATE INDEX semantic_cache_entries_lookup
               ON semantic_cache_entries (project_id, context_key, expires_at)';
    EXECUTE 'CREATE INDEX semantic_cache_entries_age
               ON semantic_cache_entries (project_id, created_at DESC)';
    EXECUTE 'CREATE INDEX semantic_cache_entries_expiry ON semantic_cache_entries (expires_at)';
  END IF;
END
$$;

-- A project's semantic cache settings, set by its admins; `{}` is off.
ALTER TABLE projects
  ADD COLUMN semantic_cache jsonb NOT NULL DEFAULT '{}'::jsonb;

-- What a request's semantic lookup did and cost; null on requests that made none. Costs follow
-- ADR 016 (the price in effect at the request) and ADR 024 (billed: 0 on a free tier).
ALTER TABLE request_records
  ADD COLUMN semantic_cache text CHECK (semantic_cache IN ('hit', 'miss', 'error')),
  ADD COLUMN semantic_similarity real,
  ADD COLUMN embedding_deployment text,
  ADD COLUMN embedding_tokens integer CHECK (embedding_tokens >= 0),
  ADD COLUMN embedding_cost_micro_usd bigint,
  ADD COLUMN embedding_billed_cost_micro_usd bigint,
  ADD COLUMN semantic_avoided_cost_micro_usd bigint,
  ADD COLUMN semantic_avoided_billed_cost_micro_usd bigint;

-- Down Migration

-- The extension stays: other objects may use it, and it holds no data.
DROP TABLE IF EXISTS semantic_cache_entries;
ALTER TABLE request_records
  DROP COLUMN semantic_cache,
  DROP COLUMN semantic_similarity,
  DROP COLUMN embedding_deployment,
  DROP COLUMN embedding_tokens,
  DROP COLUMN embedding_cost_micro_usd,
  DROP COLUMN embedding_billed_cost_micro_usd,
  DROP COLUMN semantic_avoided_cost_micro_usd,
  DROP COLUMN semantic_avoided_billed_cost_micro_usd;
ALTER TABLE projects DROP COLUMN semantic_cache;
