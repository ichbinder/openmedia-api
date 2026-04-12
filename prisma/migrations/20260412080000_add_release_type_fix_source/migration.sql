-- AlterTable: Add release_type column
ALTER TABLE "nzb_files" ADD COLUMN "release_type" TEXT;

-- Step 1: Move release type values from source to release_type
-- These are external NZBs (from NZBDonkey) that have release type in source field
UPDATE "nzb_files"
SET "release_type" = "source",
    "source" = 'external'
WHERE "source" NOT IN ('external', 'own');

-- Step 2: Fix the 7257 MongoDB-imported NZBs
-- They currently have source='external' but are actually our own NZBs
-- After Step 1, only genuine old entries remain with source='external'
-- These are the MongoDB imports that should be source='own'
-- We identify them by: source='external' AND release_type IS NULL (no release type was moved)
UPDATE "nzb_files"
SET "source" = 'own'
WHERE "source" = 'external'
  AND "release_type" IS NULL;
