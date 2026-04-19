-- CreateTable
CREATE TABLE "usenet_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "post_host" TEXT,
    "port" INTEGER NOT NULL DEFAULT 563,
    "ssl" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "iv" TEXT,
    "tag" TEXT,
    "connections" INTEGER NOT NULL DEFAULT 20,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_download" BOOLEAN NOT NULL DEFAULT false,
    "is_upload" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usenet_providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usenet_providers_name_key" ON "usenet_providers"("name");
