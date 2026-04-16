-- Mark old MongoDB-imported NzbFiles as expired
-- These 7256 entries were bulk-imported from MongoDB on 2026-03-30,
-- later set to source='own' by migration 20260412080000.
-- Their Usenet articles are DMCA'd (K052) — marking as expired
-- unblocks the auto-upload trigger while preserving history.
--
-- Criteria: source='own' AND no S3 data AND created before the
-- upload pipeline tests started (2026-04-08).
-- This excludes any real uploads from M024 testing (April 8-14).

UPDATE "nzb_files"
SET "status" = 'expired'
WHERE "source" = 'own'
  AND "s3_key" IS NULL
  AND "s3_stream_key" IS NULL
  AND "created_at" < '2026-04-08T00:00:00Z'
  AND "status" != 'expired';
