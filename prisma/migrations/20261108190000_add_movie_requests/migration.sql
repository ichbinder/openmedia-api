-- CreateTable
CREATE TABLE "movie_requests" (
    "id" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "allowed_group" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "german_only" BOOLEAN NOT NULL DEFAULT true,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "tried_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "nzb_file_id" TEXT,

    CONSTRAINT "movie_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "movie_requests_status_idx" ON "movie_requests"("status");

-- CreateIndex
CREATE INDEX "movie_requests_nzb_file_id_idx" ON "movie_requests"("nzb_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "movie_requests_user_id_tmdb_id_key" ON "movie_requests"("user_id", "tmdb_id");

-- AddForeignKey
ALTER TABLE "movie_requests" ADD CONSTRAINT "movie_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movie_requests" ADD CONSTRAINT "movie_requests_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
