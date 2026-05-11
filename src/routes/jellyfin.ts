import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";

const router = Router();
router.use(requireAuth);

// Presigned-URL TTL for Jellyfin stream requests. Short on purpose — the plugin
// always fetches a fresh URL just before play, so a long TTL adds nothing.
const STREAM_URL_TTL_SECONDS = 60 * 60; // 1h

function mimeTypeFor(opts: { hasStreamKey: boolean; fileExtension: string | null }): string {
  if (opts.hasStreamKey) return "video/mp4";
  const ext = (opts.fileExtension || "").toLowerCase();
  if (ext === ".mp4" || ext === "mp4") return "video/mp4";
  if (ext === ".mkv" || ext === "mkv") return "video/x-matroska";
  return "application/octet-stream";
}

// GET /jellyfin/library — flat list of the authenticated user's library items
// that are actually downloaded (have s3Key). One row per UserLibrary entry.
//
// Shape is intentionally lean — the Jellyfin plugin only needs enough to
// create BaseItems and let Jellyfin's TMDB provider fill in posters/metadata.
router.get("/library", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const rows = await prisma.userLibrary.findMany({
      where: {
        userId,
        removedAt: null,
        nzbFile: { s3Key: { not: null } },
      },
      include: {
        nzbFile: {
          select: {
            hash: true,
            fileSize: true,
            duration: true,
            resolution: true,
            qualityTier: true,
            movie: { select: { tmdbId: true, titleDe: true, titleEn: true, year: true } },
          },
        },
      },
      orderBy: { addedAt: "desc" },
    });

    const items = rows
      .filter((row) => row.nzbFile.movie !== null && row.nzbFile.movie.tmdbId !== null)
      .map((row) => {
        const movie = row.nzbFile.movie!;
        return {
          hash: row.nzbFile.hash,
          tmdbId: movie.tmdbId,
          title: movie.titleDe || movie.titleEn,
          year: movie.year,
          // BigInt → string for safe JSON serialization. Plugin parses as needed.
          fileSize: row.nzbFile.fileSize !== null ? row.nzbFile.fileSize.toString() : null,
          duration: row.nzbFile.duration,
          resolution: row.nzbFile.qualityTier || row.nzbFile.resolution,
        };
      });

    console.log(`[jellyfin] library: user=${userId.slice(0, 8)}... count=${items.length}`);
    res.json({ items });
  } catch (err) {
    console.error("[jellyfin] library error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Jellyfin-Library." });
  }
});

// GET /jellyfin/stream/:hash — fresh presigned URL for one library item.
//
// The plugin's IMediaSourceProvider calls this just before play. We:
//   1. Resolve NzbFile by hash
//   2. Confirm the caller has this hash in their active library (otherwise 404 —
//      never leak whether the hash exists for other users)
//   3. Pick s3StreamKey if present (browser-friendly MP4 stereo), else s3Key
//   4. HEAD-check S3 (FILE_GONE pattern — reset DB on 404, 502 on transient)
//   5. Bump lastAccessedAt (LRU tracking) fire-and-forget
//   6. Return fresh 1h presigned URL + ISO expiresAt + mimeType
router.get("/stream/:hash", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const hash = String(req.params.hash);

    const nzbFile = await prisma.nzbFile.findUnique({
      where: { hash },
      select: {
        id: true,
        hash: true,
        s3Key: true,
        s3StreamKey: true,
        s3Bucket: true,
        fileExtension: true,
      },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "Nicht gefunden." });
      return;
    }

    // Access check — user must have this hash in their library, otherwise 404
    // (not 403, to avoid revealing existence of other users' content).
    const libraryEntry = await prisma.userLibrary.findFirst({
      where: { userId, nzbFileId: nzbFile.id, removedAt: null },
      select: { id: true },
    });
    if (!libraryEntry) {
      res.status(404).json({ error: "Nicht gefunden." });
      return;
    }

    // Prefer the browser-friendly stream key (stereo MP4) — Apple TV/Swiftfin
    // can direct-play MKV, but MP4-stereo is the safest cross-client baseline.
    const streamKey = nzbFile.s3StreamKey || nzbFile.s3Key;
    if (!streamKey) {
      res.status(422).json({ error: "Film wurde noch nicht heruntergeladen." });
      return;
    }

    const { isS3Configured, generatePresignedUrl, getFileMetadata } = await import("../lib/s3.js");

    if (!isS3Configured()) {
      res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
      return;
    }

    // Verify the file actually exists in S3 before generating a presigned URL.
    // Mirrors the /downloads/jobs/:id/link FILE_GONE pattern.
    try {
      await getFileMetadata(streamKey, nzbFile.s3Bucket || undefined);
    } catch (s3Err: unknown) {
      const errObj = s3Err as { $metadata?: { httpStatusCode?: number }; name?: string; message?: string };
      const statusCode = errObj?.$metadata?.httpStatusCode || errObj?.name;
      if (statusCode === 404 || statusCode === "NotFound" || errObj?.name === "NotFound") {
        await prisma.nzbFile.update({
          where: { id: nzbFile.id },
          data: {
            s3Key: null,
            s3StreamKey: null,
            s3Bucket: null,
            fileExtension: null,
            downloadedAt: null,
            scheduledDeletionAt: null,
          },
        });
        console.warn(`[jellyfin] stream FILE_GONE: hash=${hash.slice(0, 12)}... — DB reset`);
        res.status(410).json({
          error: "Datei ist nicht mehr verfügbar. Bitte erneut herunterladen.",
          code: "FILE_GONE",
        });
        return;
      }
      console.error(`[jellyfin] stream S3 HEAD failed: hash=${hash.slice(0, 12)}...`, errObj?.message || s3Err);
      res.status(502).json({ error: "S3-Verbindung fehlgeschlagen. Bitte erneut versuchen." });
      return;
    }

    // LRU tracking — fire-and-forget so it never blocks the response.
    prisma.nzbFile
      .update({ where: { id: nzbFile.id }, data: { lastAccessedAt: new Date() } })
      .catch((err) => console.error(`[jellyfin] lastAccessedAt update failed: ${err?.message || err}`));

    const url = await generatePresignedUrl(streamKey, STREAM_URL_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + STREAM_URL_TTL_SECONDS * 1000).toISOString();
    const mimeType = mimeTypeFor({
      hasStreamKey: !!nzbFile.s3StreamKey,
      fileExtension: nzbFile.fileExtension,
    });

    console.log(`[jellyfin] stream: user=${userId.slice(0, 8)}... hash=${hash.slice(0, 12)}... mime=${mimeType}`);
    res.json({ url, expiresAt, mimeType });
  } catch (err) {
    console.error("[jellyfin] stream error:", err);
    res.status(500).json({ error: "Fehler beim Erzeugen des Stream-Links." });
  }
});

export default router;
