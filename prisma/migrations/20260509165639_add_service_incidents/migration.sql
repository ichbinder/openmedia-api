-- CreateTable
CREATE TABLE "service_incidents" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "service_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_incidents_service_status_idx" ON "service_incidents"("service", "status");
