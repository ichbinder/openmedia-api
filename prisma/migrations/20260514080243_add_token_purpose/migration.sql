-- AlterTable
ALTER TABLE "api_tokens" ADD COLUMN     "purpose" TEXT;

-- CreateIndex
CREATE INDEX "api_tokens_purpose_idx" ON "api_tokens"("purpose");
