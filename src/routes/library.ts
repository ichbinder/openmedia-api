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

    // Check if ANY user still has this film in their library
    const activeCount = await prisma.userLibrary.count({
      where: { nzbFileId, removedAt: null },
    });

    if (activeCount === 0) {
      // No user needs this file anymore → delete from S3
      const nzbFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });

      if (nzbFile?.s3Key) {
        try {
          const { deleteFile } = await import("../lib/s3.js");
          await deleteFile(nzbFile.s3Key);

          await prisma.nzbFile.update({
            where: { id: nzbFileId },
            data: { s3Key: null, s3Bucket: null, fileExtension: null, downloadedAt: null, scheduledDeletionAt: null },
          });

          console.log(`[library] S3 deleted: ${nzbFile.s3Key} (no users remaining)`);
          res.json({ removed: true, s3Deleted: true });
          return;
        } catch (s3Err) {
          console.error("[library] S3 delete failed:", s3Err);
          // S3 delete failed but library entry was removed — still report success
        }
      }
    }

    res.json({ removed: true, s3Deleted: false, activeUsers: activeCount });
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
