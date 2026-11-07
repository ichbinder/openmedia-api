-- AlterTable
ALTER TABLE "nzb_files" ADD COLUMN     "episode_id" TEXT;

-- AlterTable
ALTER TABLE "upload_jobs" ADD COLUMN     "episode_id" TEXT;

-- CreateTable
CREATE TABLE "nzb_shows" (
    "id" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "title_de" TEXT NOT NULL,
    "title_en" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "year" INTEGER,
    "poster_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nzb_shows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nzb_episodes" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "episode" INTEGER NOT NULL,
    "title_de" TEXT NOT NULL DEFAULT '',
    "air_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "show_id" TEXT NOT NULL,

    CONSTRAINT "nzb_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nzb_shows_tmdb_id_key" ON "nzb_shows"("tmdb_id");

-- CreateIndex
CREATE UNIQUE INDEX "nzb_episodes_show_id_season_episode_key" ON "nzb_episodes"("show_id", "season", "episode");

-- CreateIndex
CREATE INDEX "nzb_files_episode_id_idx" ON "nzb_files"("episode_id");

-- AddForeignKey
ALTER TABLE "nzb_episodes" ADD CONSTRAINT "nzb_episodes_show_id_fkey" FOREIGN KEY ("show_id") REFERENCES "nzb_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nzb_files" ADD CONSTRAINT "nzb_files_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "nzb_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "nzb_files" ADD CONSTRAINT "nzb_files_movie_xor_episode" CHECK ("movie_id" IS NULL OR "episode_id" IS NULL);
