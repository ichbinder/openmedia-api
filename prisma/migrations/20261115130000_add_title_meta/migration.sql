-- CreateTable
CREATE TABLE "title_meta" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tmdb_id" INTEGER NOT NULL,
    "label" TEXT,
    "brand" TEXT,
    "ratings" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER,
    "year" INTEGER,
    "status" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "title_meta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "title_meta_kind_tmdb_id_key" ON "title_meta"("kind", "tmdb_id");

-- Seed: config category for metadata providers
INSERT INTO "config_categories" ("id", "name", "display_name", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'metadata', 'Metadaten', 'Zugänge zu Film- und Seriendatenbanken (MDBList)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO NOTHING;
