-- Add CHECK constraints to vps_events table:
-- 1. Exactly one of download_job_id / upload_job_id must be set (XOR)
-- 2. job_type must be consistent with which FK is set

ALTER TABLE "vps_events"
  ADD CONSTRAINT "vps_events_exactly_one_fk"
    CHECK (num_nonnulls(download_job_id, upload_job_id) = 1),
  ADD CONSTRAINT "vps_events_job_type_download_consistent"
    CHECK (job_type <> 'download' OR download_job_id IS NOT NULL),
  ADD CONSTRAINT "vps_events_job_type_upload_consistent"
    CHECK (job_type <> 'upload' OR upload_job_id IS NOT NULL);
