-- AlterTable
ALTER TABLE "nzb_files" ADD COLUMN     "indexer_guid" TEXT;

-- CreateTable
CREATE TABLE "episode_requests" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'searching',
    "wait_reason" TEXT,
    "manual_guid" TEXT,
    "next_search_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "episode_id" TEXT NOT NULL,
    "nzb_file_id" TEXT,

    CONSTRAINT "episode_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "episode_requests_status_next_search_at_idx" ON "episode_requests"("status", "next_search_at");

-- CreateIndex
CREATE INDEX "episode_requests_episode_id_idx" ON "episode_requests"("episode_id");

-- CreateIndex
CREATE INDEX "episode_requests_nzb_file_id_idx" ON "episode_requests"("nzb_file_id");

-- CreateIndex
CREATE UNIQUE INDEX "episode_requests_user_id_episode_id_key" ON "episode_requests"("user_id", "episode_id");

-- CreateIndex
CREATE INDEX "nzb_files_indexer_guid_idx" ON "nzb_files"("indexer_guid");

-- AddForeignKey
ALTER TABLE "episode_requests" ADD CONSTRAINT "episode_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_requests" ADD CONSTRAINT "episode_requests_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "nzb_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_requests" ADD CONSTRAINT "episode_requests_nzb_file_id_fkey" FOREIGN KEY ("nzb_file_id") REFERENCES "nzb_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed: config categories for the indexer and series selection rules
INSERT INTO "config_categories" ("id", "name", "display_name", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'indexer', 'Indexer', 'Zugang zu Usenet-Indexern (Treasure Maps)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'series', 'Serien', 'Regeln für die Auswahl von Folgen-Versionen', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
