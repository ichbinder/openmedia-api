-- CreateTable
CREATE TABLE "vps_events" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "job_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vps_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vps_events_job_id_idx" ON "vps_events"("job_id");

-- CreateIndex
CREATE INDEX "vps_events_job_type_created_at_idx" ON "vps_events"("job_type", "created_at");

-- CreateIndex
CREATE INDEX "vps_events_event_type_created_at_idx" ON "vps_events"("event_type", "created_at");
