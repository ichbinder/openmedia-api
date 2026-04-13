-- AlterTable: Add media metadata fields and quality tier to nzb_files
ALTER TABLE "nzb_files" ADD COLUMN "quality_tier" TEXT;
ALTER TABLE "nzb_files" ADD COLUMN "video_width" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "video_height" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "video_bitrate" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "video_framerate" TEXT;
ALTER TABLE "nzb_files" ADD COLUMN "video_color_depth" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "hdr" BOOLEAN;
ALTER TABLE "nzb_files" ADD COLUMN "hdr_format" TEXT;
ALTER TABLE "nzb_files" ADD COLUMN "audio_codec" TEXT;
ALTER TABLE "nzb_files" ADD COLUMN "audio_channels" TEXT;
ALTER TABLE "nzb_files" ADD COLUMN "audio_bitrate" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "duration" INTEGER;
ALTER TABLE "nzb_files" ADD COLUMN "media_info" JSONB;

-- Backfill: Set qualityTier from existing resolution values
UPDATE "nzb_files" SET "quality_tier" = "resolution"
WHERE "resolution" IN ('480p', '720p', '1080p', '2160p');

-- Map 576p to 480p (SD tier)
UPDATE "nzb_files" SET "quality_tier" = '480p'
WHERE "resolution" = '576p' AND "quality_tier" IS NULL;

-- Map non-standard resolution values
UPDATE "nzb_files" SET "quality_tier" = '2160p'
WHERE "resolution" IN ('4K', '4k', 'UHD') AND "quality_tier" IS NULL;
