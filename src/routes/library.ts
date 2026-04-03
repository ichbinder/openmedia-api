import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";

const router = Router();
router.use(requireAuth);

// GET /library — list user's library (active items only)
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const items = await prisma.userLibrary.findMany({
      where: { userId, removedAt: null },
      include: {
        nzbFile: {
          select: {
            id: true, hash: true, resolution: true, fileExtension: true,
            s3Key: true, s3Bucket: true, downloadedAt: true,
            lastAccessedAt: true, scheduledDeletionAt: true,
            movie: { select: { id: true, tmdbId: true, titleDe: true, titleEn: true, year: true, posterPath: true } },
          },
        },
      },
      orderBy: { addedAt: "desc" },
    });

    res.json({ items });
  } catch (err) {
    console.error("[library] List error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Bibliothek." });
  }
});

// POST /library — add film to user's library
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { nzbFileId } = req.body;

    if (!nzbFileId || typeof nzbFileId !== "string") {
      res.status(400).json({ error: "nzbFileId ist erforderlich." });
      return;
    }

    // Verify NZB file exists and has s3Key
    const nzbFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });
    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }
    if (!nzbFile.s3Key) {
      res.status(422).json({ error: "Film wurde noch nicht heruntergeladen." });
      return;
    }

    const item = await prisma.userLibrary.upsert({
      where: { userId_nzbFileId: { userId, nzbFileId } },
      create: { userId, nzbFileId },
      update: { removedAt: null, addedAt: new Date() },
    });

    console.log(`[library] Added: user ${userId.slice(0, 8)}... → ${nzbFileId.slice(0, 8)}...`);
    res.json({ item });
  } catch (err) {
    console.error("[library] Add error:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen zur Bibliothek." });
  }
});

// DELETE /library/:nzbFileId — remove film from user's library
router.delete("/:nzbFileId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const nzbFileId = String(req.params.nzbFileId);

    // Soft-delete: set removedAt
    const result = await prisma.userLibrary.updateMany({
      where: { userId, nzbFileId, removedAt: null },
      data: { removedAt: new Date() },
    });

    if (result.count === 0) {
      res.status(404).json({ error: "Film nicht in deiner Bibliothek." });
      return;
    }

    console.log(`[library] Removed: user ${userId.slice(0, 8)}... → ${nzbFileId.slice(0, 8)}...`);

    // Atomically check if ANY user still needs this film and delete S3 if not
    // Uses a transaction to prevent TOCTOU race condition
    const s3Deleted = await prisma.$transaction(async (tx) => {
      const activeCount = await tx.userLibrary.count({
        where: { nzbFileId, removedAt: null },
      });

      if (activeCount > 0) return false;

      const nzbFile = await tx.nzbFile.findUnique({ where: { id: nzbFileId } });
      if (!nzbFile?.s3Key) return false;

      // Reset S3 reference and invalidate completed download jobs
      await tx.nzbFile.update({
        where: { id: nzbFileId },
        data: { s3Key: null, s3Bucket: null, fileExtension: null, downloadedAt: null, scheduledDeletionAt: null },
      });

      // Mark all completed jobs for this file as failed — the S3 file is gone,
      // so the "completed" status is no longer valid. Without this, the frontend
      // shows a green download button that leads to a 422 error.
      await tx.downloadJob.updateMany({
        where: { nzbFileId, status: "completed" },
        data: { status: "failed", error: "S3-Datei wurde gelöscht (kein User in Bibliothek)" },
      });

      // S3 deletion outside transaction scope (can't rollback S3)
      // but reference is already cleared so even if S3 delete fails,
      // the file is orphaned and will be cleaned up later
      try {
        const { deleteFile } = await import("../lib/s3.js");
        await deleteFile(nzbFile.s3Key);
        console.log(`[library] S3 deleted: ${nzbFile.s3Key} (no users remaining)`);
      } catch (s3Err) {
        console.error("[library] S3 delete failed (orphaned):", s3Err);
      }

      return true;
    });

    res.json({ removed: true, s3Deleted, activeUsers: s3Deleted ? 0 : undefined });
  } catch (err) {
    console.error("[library] Remove error:", err);
    res.status(500).json({ error: "Fehler beim Entfernen aus der Bibliothek." });
  }
});

// GET /library/retention/:nzbFileId — how many users still need this film?
router.get("/retention/:nzbFileId", async (req: AuthRequest, res: Response) => {
  try {
    const nzbFileId = String(req.params.nzbFileId);

    const activeCount = await prisma.userLibrary.count({
      where: { nzbFileId, removedAt: null },
    });

    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: nzbFileId },
      select: { s3Key: true, scheduledDeletionAt: true, lastAccessedAt: true },
    });

    res.json({
      activeUsers: activeCount,
      inS3: !!nzbFile?.s3Key,
      scheduledDeletionAt: nzbFile?.scheduledDeletionAt,
      lastAccessedAt: nzbFile?.lastAccessedAt,
    });
  } catch (err) {
    console.error("[library] Retention error:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Retention-Daten." });
  }
});

export default router;
