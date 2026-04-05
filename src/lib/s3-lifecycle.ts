/**
 * S3 Lifecycle Management
 *
 * Monitors S3 bucket usage and implements LRU-based cleanup:
 * - Calculates current bucket usage
 * - At 70%+ capacity: marks least-recently-used files for deletion
 * - After 3-day grace period: deletes files if no user retains them
 */

import prisma from "./prisma.js";
import { deleteFile } from "./s3.js";

const CAPACITY_THRESHOLD = 0.7; // 70%
const MAX_CAPACITY_BYTES = 1_000_000_000_000; // 1 TB (Hetzner included storage)
const DELETION_GRACE_DAYS = 3;

/**
 * Calculate total S3 usage from NzbFile records in the database.
 * Faster than ListObjects on S3 — uses fileSize from DB.
 */
export async function getStorageUsage(): Promise<{
  totalBytes: number;
  fileCount: number;
  capacityPercent: number;
  threshold: number;
  overThreshold: boolean;
}> {
  const result = await prisma.nzbFile.aggregate({
    where: { s3Key: { not: null } },
    _sum: { fileSize: true },
    _count: true,
  });

  // fileSize is BigInt, may be null for some entries
  // Estimate ~10GB per file for entries without fileSize
  const knownSize = Number(result._sum.fileSize || 0n);
  const unknownCount = await prisma.nzbFile.count({
    where: { s3Key: { not: null }, fileSize: null },
  });
  const estimatedTotal = knownSize + unknownCount * 10_000_000_000;

  const capacityPercent = estimatedTotal / MAX_CAPACITY_BYTES;

  return {
    totalBytes: estimatedTotal,
    fileCount: result._count,
    capacityPercent: Math.round(capacityPercent * 1000) / 10, // e.g. 42.3%
    threshold: CAPACITY_THRESHOLD * 100,
    overThreshold: capacityPercent >= CAPACITY_THRESHOLD,
  };
}

/**
 * Get files sorted by LRU (least recently used first).
 * Only includes files that are in S3 and not already scheduled for deletion.
 */
export async function getCleanupCandidates(limit = 20) {
  const candidates = await prisma.nzbFile.findMany({
    where: {
      s3Key: { not: null },
      scheduledDeletionAt: null,
    },
    select: {
      id: true,
      hash: true,
      resolution: true,
      fileSize: true,
      s3Key: true,
      lastAccessedAt: true,
      downloadedAt: true,
      movie: { select: { titleDe: true, titleEn: true, tmdbId: true } },
      libraryUsers: {
        where: { removedAt: null },
        select: { userId: true },
      },
    },
    orderBy: [
      { lastAccessedAt: { sort: "asc", nulls: "first" } },
      { downloadedAt: { sort: "asc", nulls: "first" } },
    ],
    take: limit,
  });

  return candidates.map((c) => ({
    id: c.id,
    hash: c.hash,
    resolution: c.resolution,
    fileSize: c.fileSize ? Number(c.fileSize) : null,
    s3Key: c.s3Key,
    lastAccessedAt: c.lastAccessedAt,
    downloadedAt: c.downloadedAt,
    movie: c.movie,
    activeUsers: c.libraryUsers.length,
  }));
}

/**
 * Mark files for deletion (3-day grace period).
 * Only marks files where no user has them in their active library.
 * Returns number of files marked.
 */
export async function markForDeletion(fileIds: string[]): Promise<number> {
  const deletionDate = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);

  let marked = 0;
  for (const id of fileIds) {
    // Atomic: only mark if no active library users
    const result = await prisma.nzbFile.updateMany({
      where: {
        id,
        scheduledDeletionAt: null,
        libraryUsers: { none: { removedAt: null } },
      },
      data: { scheduledDeletionAt: deletionDate },
    });

    if (result.count > 0) {
      marked++;
      console.log(`[s3-lifecycle] Marked for deletion: ${id} (in ${DELETION_GRACE_DAYS} days)`);
    }
  }

  return marked;
}

/**
 * Execute pending deletions — delete files whose grace period has expired.
 * Double-checks that no user has re-added the film to their library.
 */
export async function executePendingDeletions(): Promise<{
  deleted: number;
  skipped: number;
  errors: number;
}> {
  const pendingFiles = await prisma.nzbFile.findMany({
    where: {
      scheduledDeletionAt: { lte: new Date() },
      s3Key: { not: null },
    },
    select: { id: true, hash: true, s3Key: true, s3StreamKey: true },
  });

  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of pendingFiles) {
    // Re-check: has a user re-added this film?
    const activeUsers = await prisma.userLibrary.count({
      where: { nzbFileId: file.id, removedAt: null },
    });

    if (activeUsers > 0) {
      // User re-added → cancel deletion
      await prisma.nzbFile.update({
        where: { id: file.id },
        data: { scheduledDeletionAt: null },
      });
      console.log(`[s3-lifecycle] Skipped (user re-added): ${file.hash.slice(0, 16)}...`);
      skipped++;
      continue;
    }

    try {
      const s3Key = file.s3Key!;
      const s3StreamKey = file.s3StreamKey;

      // DB update first — clear reference before S3 delete
      // Safer: orphaned S3 file > DB ref pointing to deleted S3 object
      await prisma.nzbFile.update({
        where: { id: file.id },
        data: {
          s3Key: null,
          s3StreamKey: null,
          s3Bucket: null,
          fileExtension: null,
          downloadedAt: null,
          scheduledDeletionAt: null,
        },
      });

      try {
        await deleteFile(s3Key);
        if (s3StreamKey) {
          await deleteFile(s3StreamKey);
          console.log(`[s3-lifecycle] Stream version deleted: ${file.hash.slice(0, 16)}...`);
        }
      } catch (s3Err) {
        console.error(`[s3-lifecycle] S3 delete failed (orphaned): ${file.hash.slice(0, 16)}...`, s3Err);
      }

      console.log(`[s3-lifecycle] Deleted: ${file.hash.slice(0, 16)}...`);
      deleted++;
    } catch (err) {
      console.error(`[s3-lifecycle] Delete failed: ${file.hash.slice(0, 16)}...`, err);
      errors++;
    }
  }

  return { deleted, skipped, errors };
}

/**
 * Run full cleanup cycle:
 * 1. Check storage usage
 * 2. If over threshold: mark LRU files for deletion
 * 3. Execute any pending deletions whose grace period expired
 */
export async function runCleanupCycle(): Promise<{
  usage: Awaited<ReturnType<typeof getStorageUsage>>;
  markedForDeletion: number;
  executed: Awaited<ReturnType<typeof executePendingDeletions>>;
}> {
  console.log("[s3-lifecycle] Starting cleanup cycle...");

  const usage = await getStorageUsage();
  console.log(`[s3-lifecycle] Usage: ${usage.capacityPercent}% (${usage.fileCount} files)`);

  let markedForDeletion = 0;

  if (usage.overThreshold) {
    console.log(`[s3-lifecycle] Over ${usage.threshold}% threshold — finding cleanup candidates`);
    const candidates = await getCleanupCandidates(10);
    const toMark = candidates.filter((c) => c.activeUsers === 0).map((c) => c.id);

    if (toMark.length > 0) {
      markedForDeletion = await markForDeletion(toMark);
      console.log(`[s3-lifecycle] Marked ${markedForDeletion} files for deletion (3-day grace)`);
    } else {
      console.log("[s3-lifecycle] No candidates without active users");
    }
  }

  // Always execute pending deletions (even if under threshold)
  const executed = await executePendingDeletions();

  console.log(`[s3-lifecycle] Cycle complete: ${executed.deleted} deleted, ${executed.skipped} skipped, ${markedForDeletion} newly marked`);

  return { usage, markedForDeletion, executed };
}
