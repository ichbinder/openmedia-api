/*
  Warnings:

  - You are about to drop the column `job_id` on the `vps_events` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "vps_events_event_type_created_at_idx";

-- DropIndex
DROP INDEX "vps_events_job_id_idx";

-- DropIndex
DROP INDEX "vps_events_job_type_created_at_idx";

-- AlterTable
ALTER TABLE "vps_events" DROP COLUMN "job_id",
ADD COLUMN     "download_job_id" TEXT,
ADD COLUMN     "upload_job_id" TEXT;

-- CreateIndex
CREATE INDEX "vps_events_download_job_id_created_at_idx" ON "vps_events"("download_job_id", "created_at");

-- CreateIndex
CREATE INDEX "vps_events_upload_job_id_created_at_idx" ON "vps_events"("upload_job_id", "created_at");

-- CreateIndex
CREATE INDEX "vps_events_download_job_id_event_type_created_at_idx" ON "vps_events"("download_job_id", "event_type", "created_at");

-- CreateIndex
CREATE INDEX "vps_events_upload_job_id_event_type_created_at_idx" ON "vps_events"("upload_job_id", "event_type", "created_at");

-- AddForeignKey
ALTER TABLE "vps_events" ADD CONSTRAINT "vps_events_download_job_id_fkey" FOREIGN KEY ("download_job_id") REFERENCES "download_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vps_events" ADD CONSTRAINT "vps_events_upload_job_id_fkey" FOREIGN KEY ("upload_job_id") REFERENCES "upload_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
