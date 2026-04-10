/*
  Warnings:

  - You are about to drop the column `own_nzb_s3_key` on the `nzb_files` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "nzb_files" DROP COLUMN "own_nzb_s3_key";
