-- Up Migration

-- Requests answered with the upstream answer of an identical request in flight on the same
-- gateway instance (M14, ADR 031). Like a cache hit, such a request made no provider attempt and
-- cost nothing. A worker that predates the column writes none, so the default is false. A constant
-- default adds the column without rewriting the table.
ALTER TABLE request_records
  ADD COLUMN coalesced boolean NOT NULL DEFAULT false;

-- Down Migration

ALTER TABLE request_records DROP COLUMN coalesced;
