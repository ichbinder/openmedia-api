import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../test/setup.js";

// Import lifecycle functions — they use prisma directly
import {
  getStorageUsage,
  getCleanupCandidates,
  markForDeletion,
  executePendingDeletions,
} from "../lib/s3-lifecycle.js";

async function createNzbFileInS3(hash: string, opts: { fileSize?: bigint; lastAccessedAt?: Date; scheduledDeletionAt?: Date } = {}) {
  const movie = await prisma.nzbMovie.create({
    data: { titleDe: "Test", titleEn: "Test", year: 2024 },
  });
  return prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash,
      originalFilename: `${hash}.nzb`,
      s3Key: `${hash}/${hash}.mkv`,
      s3Bucket: "openmedia-files",
      fileExtension: ".mkv",
      downloadedAt: new Date(),
      fileSize: opts.fileSize ?? 10_000_000_000n, // 10 GB default
      lastAccessedAt: opts.lastAccessedAt ?? null,
      scheduledDeletionAt: opts.scheduledDeletionAt ?? null,
    },
  });
}

describe("S3 Lifecycle", () => {
  describe("getStorageUsage", () => {
    it("berechnet 0 bei leerer DB", async () => {
      const usage = await getStorageUsage();
      expect(usage.fileCount).toBe(0);
      expect(usage.totalBytes).toBe(0);
      expect(usage.overThreshold).toBe(false);
    });

    it("zählt nur Dateien mit s3Key", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "T", titleEn: "T", year: 2024 },
      });
      // File IN S3
      await prisma.nzbFile.create({
        data: { movieId: movie.id, hash: "in-s3", originalFilename: "t.nzb", s3Key: "x/x.mkv", fileSize: 5_000_000_000n },
      });
      // File NOT in S3
      await prisma.nzbFile.create({
        data: { movieId: movie.id, hash: "not-s3", originalFilename: "t2.nzb", fileSize: 5_000_000_000n },
      });

      const usage = await getStorageUsage();
      expect(usage.fileCount).toBe(1);
    });
  });

  describe("getCleanupCandidates", () => {
    it("sortiert nach lastAccessedAt (älteste zuerst)", async () => {
      const old = await createNzbFileInS3("old-hash", {
        lastAccessedAt: new Date("2024-01-01"),
      });
      const recent = await createNzbFileInS3("recent-hash", {
        lastAccessedAt: new Date("2025-12-01"),
      });
      const never = await createNzbFileInS3("never-hash"); // null = never accessed

      const candidates = await getCleanupCandidates(10);
      // null (never) first, then oldest
      expect(candidates[0].hash).toBe("never-hash");
      expect(candidates[1].hash).toBe("old-hash");
      expect(candidates[2].hash).toBe("recent-hash");
    });

    it("excludiert Dateien die schon zur Löschung markiert sind", async () => {
      await createNzbFileInS3("scheduled-hash", {
        scheduledDeletionAt: new Date("2099-01-01"),
      });
      await createNzbFileInS3("normal-hash");

      const candidates = await getCleanupCandidates(10);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].hash).toBe("normal-hash");
    });

    it("zeigt Anzahl aktiver Library-User", async () => {
      const file = await createNzbFileInS3("lib-hash");
      const user = await prisma.user.create({
        data: { email: `lc-${Date.now()}@test.de`, password: "$2b$10$hash", name: "T" },
      });
      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: file.id },
      });

      const candidates = await getCleanupCandidates(10);
      expect(candidates[0].activeUsers).toBe(1);
    });
  });

  describe("markForDeletion", () => {
    it("markiert Dateien ohne aktive Library-User", async () => {
      const file = await createNzbFileInS3("mark-hash");

      const marked = await markForDeletion([file.id]);
      expect(marked).toBe(1);

      const updated = await prisma.nzbFile.findUnique({ where: { id: file.id } });
      expect(updated!.scheduledDeletionAt).not.toBeNull();
    });

    it("markiert NICHT Dateien mit aktiven Library-Usern", async () => {
      const file = await createNzbFileInS3("skip-hash");
      const user = await prisma.user.create({
        data: { email: `md-${Date.now()}@test.de`, password: "$2b$10$hash", name: "T" },
      });
      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: file.id },
      });

      const marked = await markForDeletion([file.id]);
      expect(marked).toBe(0);

      const updated = await prisma.nzbFile.findUnique({ where: { id: file.id } });
      expect(updated!.scheduledDeletionAt).toBeNull();
    });
  });

  describe("executePendingDeletions", () => {
    it("überspringt Dateien deren User sie re-added hat", async () => {
      const file = await createNzbFileInS3("readd-hash", {
        scheduledDeletionAt: new Date("2020-01-01"), // expired
      });
      const user = await prisma.user.create({
        data: { email: `ep-${Date.now()}@test.de`, password: "$2b$10$hash", name: "T" },
      });
      // User re-added during grace period
      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: file.id },
      });

      const result = await executePendingDeletions();
      expect(result.skipped).toBe(1);
      expect(result.deleted).toBe(0);

      // scheduledDeletionAt should be cleared
      const updated = await prisma.nzbFile.findUnique({ where: { id: file.id } });
      expect(updated!.scheduledDeletionAt).toBeNull();
      expect(updated!.s3Key).not.toBeNull(); // still in S3
    });
  });
});
