-- AlterTable
ALTER TABLE "nzb_files" ADD COLUMN     "own_nzb_s3_key" TEXT,
ADD COLUMN     "own_usenet_hash" TEXT,
ADD COLUMN     "own_usenet_uploaded_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "upload_jobs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "hetzner_server_id" INTEGER,
    "hetzner_server_ip" TEXT,
    "nzb_s3_key" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "nzb_file_id" TEXT NOT NULL,

    CONSTRAINT "upload_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_jobs_nzb_file_id_idx" ON "upload_jobs"("nzb_file_id");

-- CreateIndex
CREATE INDEX "upload_jobs_status_idx" ON "upload_jobs"("status");

-- CreateIndex
CREATE INDEX "nzb_files_own_usenet_hash_idx" ON "nzb_files"("own_usenet_hash");

-- AddForeignKey
ALTER TABLE "upload_jobs" ADD CONSTRAINT "upload_jobs_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
