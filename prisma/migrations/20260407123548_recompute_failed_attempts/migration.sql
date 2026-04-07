-- Recompute failedAttempts from actual failed jobs and auto-mark broken NzbFiles.
--
-- Background: Before M020/S02, failedAttempts was only incremented from the
-- manual PATCH /downloads/jobs/:id/status endpoint. Failures from the
-- provisioner and reconciler bypassed the counter, leaving NzbFiles with
-- artificially low counts (e.g. failedAttempts=2 when 13 jobs actually failed).
--
-- This migration:
-- 1. Recomputes failed_attempts from the actual count of failed download_jobs
-- 2. Auto-marks NzbFiles as broken when failed_attempts >= 3 and not already broken
--    (only for nzb_files that don't already have an s3_key — broken status
--     is irrelevant if the movie is already on S3)

WITH job_counts AS (
  SELECT
    nzb_file_id,
    COUNT(*) FILTER (WHERE status = 'failed') AS actual_failures
  FROM download_jobs
  GROUP BY nzb_file_id
)
UPDATE nzb_files
SET failed_attempts = job_counts.actual_failures
FROM job_counts
WHERE nzb_files.id = job_counts.nzb_file_id
  AND nzb_files.failed_attempts <> job_counts.actual_failures;

-- Auto-mark as broken any NzbFile that has 3+ failures, isn't already broken,
-- and isn't already on S3 (S3-available files should never be broken)
UPDATE nzb_files
SET
  status = 'broken',
  broken_reason = COALESCE(
    broken_reason,
    'Download ' || failed_attempts || 'x fehlgeschlagen (auto-detected at migration)'
  )
WHERE failed_attempts >= 3
  AND status <> 'broken'
  AND s3_key IS NULL;
