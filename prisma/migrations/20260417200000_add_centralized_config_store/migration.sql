-- CreateTable: config_categories
CREATE TABLE "config_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable: config_entries
CREATE TABLE "config_entries" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "iv" TEXT,
    "tag" TEXT,
    "display_name" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "config_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable: config_profiles
CREATE TABLE "config_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: config_profile_categories (n:m join)
CREATE TABLE "config_profile_categories" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "config_profile_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable: config_history
CREATE TABLE "config_history" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entry_id" TEXT NOT NULL,

    CONSTRAINT "config_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "config_categories_name_key" ON "config_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "config_entries_category_id_key_key" ON "config_entries"("category_id", "key");

-- CreateIndex
CREATE INDEX "config_entries_category_id_idx" ON "config_entries"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "config_profiles_name_key" ON "config_profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "config_profile_categories_profile_id_category_id_key" ON "config_profile_categories"("profile_id", "category_id");

-- CreateIndex
CREATE INDEX "config_history_entry_id_idx" ON "config_history"("entry_id");

-- CreateIndex
CREATE INDEX "config_history_created_at_idx" ON "config_history"("created_at");

-- AddForeignKey
ALTER TABLE "config_entries" ADD CONSTRAINT "config_entries_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "config_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_profile_categories" ADD CONSTRAINT "config_profile_categories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "config_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_profile_categories" ADD CONSTRAINT "config_profile_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "config_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_history" ADD CONSTRAINT "config_history_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "config_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: Default categories
INSERT INTO "config_categories" ("id", "name", "display_name", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 's3', 'S3 Storage', 'S3-kompatibler Object Storage (Hetzner)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'usenet_download', 'Usenet Download', 'Usenet-Server für SABnzbd Downloads', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'usenet_upload', 'Usenet Upload', 'Usenet-Provider für Nyuu Uploads', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'nzb_service', 'NZB Service', 'NZB File Service (openmedia-nzb)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'hetzner', 'Hetzner Infrastructure', 'Hetzner Cloud API und VPS-Konfiguration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'docker_images', 'Docker Images', 'Container-Images für Download/Upload VPS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'runtime', 'Runtime', 'Laufzeit-Konfiguration (Auto-Provision, etc.)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Seed: Default profiles
INSERT INTO "config_profiles" ("id", "name", "display_name", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'download_vps', 'Download VPS', 'Konfiguration für Download-VPS (SABnzbd)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'upload_vps', 'Upload VPS', 'Konfiguration für Upload-VPS (Nyuu)', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Seed: Profile → Category mappings
-- download_vps needs: s3, usenet_download, nzb_service, docker_images
INSERT INTO "config_profile_categories" ("id", "profile_id", "category_id")
SELECT gen_random_uuid(), p.id, c.id
FROM "config_profiles" p, "config_categories" c
WHERE p.name = 'download_vps' AND c.name IN ('s3', 'usenet_download', 'nzb_service', 'docker_images');

-- upload_vps needs: s3, usenet_upload, nzb_service, docker_images
INSERT INTO "config_profile_categories" ("id", "profile_id", "category_id")
SELECT gen_random_uuid(), p.id, c.id
FROM "config_profiles" p, "config_categories" c
WHERE p.name = 'upload_vps' AND c.name IN ('s3', 'usenet_upload', 'nzb_service', 'docker_images');
