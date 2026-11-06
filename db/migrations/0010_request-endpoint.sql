-- Up Migration

-- Which /v1 endpoint a request came to (M13): chat completions or embeddings. Every row before
-- M13 was a chat request, and a worker that predates the column writes none, so the default is
-- `chat`. A constant default adds the column without rewriting the table.
ALTER TABLE request_records
  ADD COLUMN endpoint text NOT NULL DEFAULT 'chat'
    CHECK (endpoint IN ('chat', 'embeddings'));

-- Down Migration

ALTER TABLE request_records DROP COLUMN endpoint;
