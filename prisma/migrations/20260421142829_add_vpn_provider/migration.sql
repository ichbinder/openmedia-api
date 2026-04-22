-- CreateTable
CREATE TABLE "vpn_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "config_blob" TEXT NOT NULL,
    "config_blob_iv" TEXT NOT NULL,
    "config_blob_tag" TEXT NOT NULL,
    "username" TEXT,
    "username_iv" TEXT,
    "username_tag" TEXT,
    "password" TEXT,
    "password_iv" TEXT,
    "password_tag" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vpn_providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vpn_providers_name_key" ON "vpn_providers"("name");
