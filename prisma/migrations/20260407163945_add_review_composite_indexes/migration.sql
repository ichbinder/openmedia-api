-- CreateIndex
CREATE INDEX "download_jobs_status_review_expires_at_idx" ON "download_jobs"("status", "review_expires_at");

-- CreateIndex
CREATE INDEX "download_jobs_status_tmdb_retry_after_idx" ON "download_jobs"("status", "tmdb_retry_after");
