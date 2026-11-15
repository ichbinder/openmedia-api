-- CreateTable
CREATE TABLE "ai_settings" (
    "user_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "key_cipher" TEXT,
    "key_iv" TEXT,
    "key_tag" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "suggestion_run" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "model" TEXT NOT NULL,
    "because_kind" TEXT,
    "because_tmdb_id" INTEGER,
    "because_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "suggestion_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggestion" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "title_dismissal" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "title_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "title_info" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER,
    "genres" TEXT[],
    "overview" TEXT NOT NULL,
    "poster_path" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "title_info_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suggestion_run_user_id_started_at_idx" ON "suggestion_run"("user_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "title_dismissal_user_id_kind_tmdb_id_key" ON "title_dismissal"("user_id", "kind", "tmdb_id");

-- CreateIndex
CREATE UNIQUE INDEX "title_info_kind_tmdb_id_key" ON "title_info"("kind", "tmdb_id");

-- AddForeignKey
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion_run" ADD CONSTRAINT "suggestion_run_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggestion" ADD CONSTRAINT "suggestion_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "suggestion_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "title_dismissal" ADD CONSTRAINT "title_dismissal_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

