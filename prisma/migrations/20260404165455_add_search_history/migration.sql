-- CreateTable
CREATE TABLE "search_history" (
    "id" TEXT NOT NULL,
    "movie_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "poster_path" TEXT,
    "vote_average" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "release_date" TEXT NOT NULL DEFAULT '',
    "searched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "search_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "search_history_user_id_searched_at_idx" ON "search_history"("user_id", "searched_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_history_user_id_movie_id_key" ON "search_history"("user_id", "movie_id");

-- AddForeignKey
ALTER TABLE "search_history" ADD CONSTRAINT "search_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
