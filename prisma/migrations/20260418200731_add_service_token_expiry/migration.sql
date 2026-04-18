-- AlterTable: add expires_at with a default for existing rows (24h from now)
ALTER TABLE "service_tokens" ADD COLUMN "expires_at" TIMESTAMP(3) NOT NULL DEFAULT NOW() + INTERVAL '24 hours';

-- Remove the default after backfill so new rows must provide a value
ALTER TABLE "service_tokens" ALTER COLUMN "expires_at" DROP DEFAULT;
