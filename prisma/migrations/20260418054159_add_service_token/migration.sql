/*
  Warnings:

  - You are about to drop the column `own_usenet_hash` on the `nzb_files` table. All the data in the column will be lost.
  - You are about to drop the column `own_usenet_uploaded_at` on the `nzb_files` table. All the data in the column will be lost.
  - Made the column `source` on table `nzb_files` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "nzb_files_own_usenet_hash_idx";

-- AlterTable
ALTER TABLE "nzb_files" DROP COLUMN "own_usenet_hash",
DROP COLUMN "own_usenet_uploaded_at",
ALTER COLUMN "source" SET NOT NULL,
ALTER COLUMN "source" SET DEFAULT 'external';

-- AlterTable
ALTER TABLE "upload_jobs" ADD COLUMN     "movie_id" TEXT,
ADD COLUMN     "nzb_hash" TEXT;

-- CreateTable
CREATE TABLE "service_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_tokens_token_hash_key" ON "service_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "service_tokens_job_id_idx" ON "service_tokens"("job_id");

-- CreateIndex
CREATE INDEX "nzb_files_source_idx" ON "nzb_files"("source");
