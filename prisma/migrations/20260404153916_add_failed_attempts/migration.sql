-- CreateTable
CREATE TABLE "nzb_movies" (
    "id" TEXT NOT NULL,
    "tmdb_id" INTEGER,
    "imdb_id" TEXT,
    "title_de" TEXT NOT NULL,
    "title_en" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "year" INTEGER,
    "poster_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nzb_movies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nzb_files" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_size" BIGINT,
    "resolution" TEXT,
    "audio_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subtitle_languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codec" TEXT,
    "source" TEXT,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "broken_reason" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "s3_key" TEXT,
    "s3_bucket" TEXT,
    "file_extension" TEXT,
    "downloaded_at" TIMESTAMP(3),
    "last_accessed_at" TIMESTAMP(3),
    "scheduled_deletion_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "movie_id" TEXT NOT NULL,

    CONSTRAINT "nzb_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_library" (
    "id" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),
    "user_id" TEXT NOT NULL,
    "nzb_file_id" TEXT NOT NULL,

    CONSTRAINT "user_library_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_jobs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "user_id" TEXT,
    "hetzner_server_id" INTEGER,
    "hetzner_server_ip" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "nzb_file_id" TEXT NOT NULL,

    CONSTRAINT "download_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encrypted_configs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encrypted_value" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encrypted_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nzb_movies_tmdb_id_key" ON "nzb_movies"("tmdb_id");

-- CreateIndex
CREATE UNIQUE INDEX "nzb_movies_imdb_id_key" ON "nzb_movies"("imdb_id");

-- CreateIndex
CREATE UNIQUE INDEX "nzb_files_hash_key" ON "nzb_files"("hash");

-- CreateIndex
CREATE INDEX "nzb_files_movie_id_idx" ON "nzb_files"("movie_id");

-- CreateIndex
CREATE INDEX "user_library_nzb_file_id_idx" ON "user_library"("nzb_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_library_user_id_nzb_file_id_key" ON "user_library"("user_id", "nzb_file_id");

-- CreateIndex
CREATE INDEX "download_jobs_nzb_file_id_idx" ON "download_jobs"("nzb_file_id");

-- CreateIndex
CREATE INDEX "download_jobs_status_idx" ON "download_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "encrypted_configs_key_key" ON "encrypted_configs"("key");

-- AddForeignKey
ALTER TABLE "nzb_files" ADD CONSTRAINT "nzb_files_movie_id_fkey" FOREIGN KEY ("movie_id") REFERENCES "nzb_movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_library" ADD CONSTRAINT "user_library_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_library" ADD CONSTRAINT "user_library_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_jobs" ADD CONSTRAINT "download_jobs_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
