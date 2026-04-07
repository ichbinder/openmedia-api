-- AlterTable
ALTER TABLE "download_jobs" ADD COLUMN     "review_expires_at" TIMESTAMP(3),
ADD COLUMN     "tmdb_retry_after" TIMESTAMP(3),
ADD COLUMN     "tmdb_retry_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "nzb_files" ALTER COLUMN "movie_id" DROP NOT NULL;
