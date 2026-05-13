import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";

const router = Router();

// Token-via-query fallback for /stream/:hash only.
//
// STRM files (which Jellyfin/Swiftfin opens as plain URLs) cannot send custom
// Authorization headers, so we accept ?token=<JWT|om_apiToken> as a fallback.
// We promote the query token into the Authorization header and *delete* the
// query param so downstream logging and error rendering can never reflect it.
//
// Scope-limited to /stream/:hash on purpose — /library has no STRM use case
// and a smaller token-leak surface is better.
export const STREAM_PATH_RE = /^\/stream\/[^/]+\/?$/;
export const MIN_TOKEN_LEN = 20; // shortest plausible JWT or om_-token
export const MAX_TOKEN_LEN = 4096; // generous JWT upper bound; protects logs/headers

// Exported for direct unit testing — the named export ensures regression tests
// can assert token redaction independently of the surrounding route.
export function streamTokenFallback(req: Request, _res: Response, next: NextFunction): void {
  if (!STREAM_PATH_RE.test(req.path)) return next();

  const raw = req.query.token;

  // ALWAYS strip the token from req.query AND req.url FIRST — before any early
  // return. Otherwise a request that already has an Authorization header, or a
  // token outside the acceptable length range, would leave `token=<value>` in
  // req.url where downstream access loggers and error handlers can see it.
  if (typeof raw === "string") {
    delete (req.query as Record<string, unknown>).token;
    if (req.url.includes("token=")) {
      const [pathPart, queryPart] = req.url.split("?", 2);
      if (queryPart) {
        const filtered = queryPart
          .split("&")
          .filter((p) => !p.startsWith("token="))
          .join("&");
        req.url = filtered ? `${pathPart}?${filtered}` : pathPart;
      }
    }
  }

  if (req.headers.authorization) return next();
  if (typeof raw !== "string") return next();
  if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) return next();

  req.headers.authorization = `Bearer ${raw}`;

  // Mark how this request was authenticated for the stream-handler log line.
  (req as AuthRequest & { authSource?: "query" | "header" }).authSource = "query";
  next();
}

router.use(streamTokenFallback);

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

// GET /jellyfin/stream/:hash — 302 redirect to a fresh S3 presigned URL.
//
// Architecture decision: STRM → API → 302 → S3-Presigned (D-jellyfin-strm-302).
// The plugin/Swiftfin follows the redirect and Direct-Plays from S3.
//
// We:
//   1. Resolve NzbFile by hash
//   2. Confirm the caller has this hash in their active library (otherwise 404 —
//      never leak whether the hash exists for other users)
//   3. Pick s3StreamKey if present (browser-friendly MP4 stereo), else s3Key
//   4. HEAD-check S3 (FILE_GONE pattern — reset DB on 404, 502 on transient)
//   5. Bump lastAccessedAt (LRU tracking) fire-and-forget
//   6. 302 Redirect to fresh 1h presigned URL (Cache-Control: no-store)
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

    const mimeType = mimeTypeFor({
      hasStreamKey: !!nzbFile.s3StreamKey,
      fileExtension: nzbFile.fileExtension,
    });
    const url = await generatePresignedUrl(streamKey, STREAM_URL_TTL_SECONDS, {
      bucket: nzbFile.s3Bucket || undefined,
      responseContentType: mimeType,
    });

    const authSource = (req as AuthRequest & { authSource?: "query" | "header" }).authSource || "header";
    console.log(
      `[jellyfin] stream: user=${userId.slice(0, 8)}... hash=${hash.slice(0, 12)}... mime=${mimeType} auth=${authSource} → 302`,
    );

    // 302 redirect — clients (Swiftfin/Jellyfin plugin) follow to S3 for Direct-Play.
    // no-store: each play resolves a fresh URL so TTL stays honest.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, url);
  } catch (err) {
    console.error("[jellyfin] stream error:", err);
    res.status(500).json({ error: "Fehler beim Erzeugen des Stream-Links." });
  }
});

export default router;
