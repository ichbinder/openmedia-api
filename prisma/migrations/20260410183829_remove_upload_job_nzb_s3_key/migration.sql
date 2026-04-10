/*
  Warnings:

  - You are about to drop the column `nzb_s3_key` on the `upload_jobs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "upload_jobs" DROP COLUMN "nzb_s3_key";
