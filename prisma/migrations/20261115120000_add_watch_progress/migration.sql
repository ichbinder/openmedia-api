-- CreateTable
CREATE TABLE "watch_progress" (
    "id" TEXT NOT NULL,
    "position_sec" INTEGER NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "finished_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "hidden_at" TIMESTAMP(3),
    "user_id" TEXT NOT NULL,
    "movie_id" TEXT,
    "episode_id" TEXT,
    "nzb_file_id" TEXT,

    CONSTRAINT "watch_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watch_progress_user_id_updated_at_idx" ON "watch_progress"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "watch_progress_user_id_movie_id_key" ON "watch_progress"("user_id", "movie_id");

-- CreateIndex
CREATE UNIQUE INDEX "watch_progress_user_id_episode_id_key" ON "watch_progress"("user_id", "episode_id");

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_movie_id_fkey" FOREIGN KEY ("movie_id") REFERENCES "nzb_movies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "nzb_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_progress" ADD CONSTRAINT "watch_progress_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

