-- CreateTable
CREATE TABLE "precache_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttl_seconds" INTEGER NOT NULL DEFAULT 604800,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "reason" TEXT,
    "last_event_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plugin_install_id" TEXT,
    "size_bytes" BIGINT,
    "bytes_downloaded" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "precache_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "precache_requests_state_requested_at_idx" ON "precache_requests"("state", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "precache_requests_user_id_hash_key" ON "precache_requests"("user_id", "hash");

-- AddForeignKey
ALTER TABLE "precache_requests" ADD CONSTRAINT "precache_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
