-- CreateTable
CREATE TABLE "title_rating" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "verdict" TEXT,
    "tags" TEXT[],
    "for_whom" TEXT,
    "source" TEXT NOT NULL,
    "rated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "title_rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taste_profile" (
    "user_id" TEXT NOT NULL,
    "persons" JSONB NOT NULL DEFAULT '[]',
    "genres" TEXT[],
    "likes_text" TEXT NOT NULL DEFAULT '',
    "trakt_imported_at" TIMESTAMP(3),
    "trakt_import_counts" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "taste_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "title_rating_user_id_kind_tmdb_id_key" ON "title_rating"("user_id", "kind", "tmdb_id");

-- AddForeignKey
ALTER TABLE "title_rating" ADD CONSTRAINT "title_rating_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "taste_profile" ADD CONSTRAINT "taste_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

