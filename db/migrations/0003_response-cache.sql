-- Up Migration

-- Requests answered from the exact-match response cache (ADR 013). Their usage row has the cached
-- token counts and a cost of zero, and no provider attempt.
ALTER TABLE request_records ADD COLUMN cache_hit boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE request_records DROP COLUMN cache_hit;
