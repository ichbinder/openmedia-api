import { Router, type Response } from "express";
import multer from "multer";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { parseNzbName, calculateHash } from "../lib/nzb-parser.js";

// Select fields for NzbFile responses
const nzbFileSelect = {
  id: true, hash: true, originalFilename: true, fileSize: true,
  resolution: true, audioLanguages: true, subtitleLanguages: true,
  codec: true, source: true, status: true, brokenReason: true,
  s3Key: true, s3Bucket: true, fileExtension: true, downloadedAt: true,
  createdAt: true, updatedAt: true, movieId: true,
} as const;
import { searchTmdbMovie } from "../lib/tmdb.js";

const router = Router();

router.use(requireAuth);

const VALID_STATUSES = ["ok", "broken", "untested"] as const;

/** Convert BigInt fileSize to string for JSON serialization */
function serializeNzbFile(file: any) {
  return { ...file, fileSize: file.fileSize?.toString() ?? null };
}

/** Serialize movie with its NZB files */
function serializeMovieWithFiles(movie: any) {
  if (!movie.nzbFiles) return movie;
  return { ...movie, nzbFiles: movie.nzbFiles.map(serializeNzbFile) };
}

// GET /nzb/movies — list all NZB movies
router.get("/movies", async (_req: AuthRequest, res: Response) => {
  try {
    const movies = await prisma.nzbMovie.findMany({
      include: { nzbFiles: { select: { id: true, hash: true, resolution: true, audioLanguages: true, status: true } } },
      orderBy: { updatedAt: "desc" },
    });
    res.json({ movies: movies.map(serializeMovieWithFiles) });
  } catch (err) {
    console.error("[nzb] List movies error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Filme." });
  }
});

// GET /nzb/movies/:id — get movie with all NZB files
router.get("/movies/:id", async (req: AuthRequest, res: Response) => {
  try {
    const movie = await prisma.nzbMovie.findUnique({
      where: { id: String(req.params.id) },
      include: { nzbFiles: { select: nzbFileSelect } },
    });

    if (!movie) {
      res.status(404).json({ error: "Film nicht gefunden." });
      return;
    }

    res.json({ movie: serializeMovieWithFiles(movie) });
  } catch (err) {
    console.error("[nzb] Get movie error:", err);
    res.status(500).json({ error: "Fehler beim Laden des Films." });
  }
});

// POST /nzb/movies — create a movie entry
router.post("/movies", async (req: AuthRequest, res: Response) => {
  try {
    const { tmdbId, imdbId, titleDe, titleEn, description, year, posterPath } = req.body;

    if (!titleDe || !titleEn) {
      res.status(400).json({ error: "titleDe und titleEn sind erforderlich." });
      return;
    }

    const movie = await prisma.nzbMovie.create({
      data: {
        tmdbId: tmdbId ? Number(tmdbId) : null,
        imdbId: imdbId || null,
        titleDe,
        titleEn,
        description: description || "",
        year: year ? Number(year) : null,
        posterPath: posterPath || null,
      },
    });

    console.log(`[nzb] Movie created: ${titleEn} (${movie.id})`);
    res.status(201).json({ movie });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Film mit dieser TMDB/IMDB-ID existiert bereits." });
      return;
    }
    console.error("[nzb] Create movie error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Films." });
  }
});

// PUT /nzb/movies/:id — update a movie
router.put("/movies/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { tmdbId, imdbId, titleDe, titleEn, description, year, posterPath } = req.body;

    const movie = await prisma.nzbMovie.update({
      where: { id: String(req.params.id) },
      data: {
        ...(tmdbId !== undefined && { tmdbId: tmdbId ? Number(tmdbId) : null }),
        ...(imdbId !== undefined && { imdbId: imdbId || null }),
        ...(titleDe !== undefined && { titleDe }),
        ...(titleEn !== undefined && { titleEn }),
        ...(description !== undefined && { description }),
        ...(year !== undefined && { year: year ? Number(year) : null }),
        ...(posterPath !== undefined && { posterPath: posterPath || null }),
      },
    });

    console.log(`[nzb] Movie updated: ${movie.titleEn} (${movie.id})`);
    res.json({ movie });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(404).json({ error: "Film nicht gefunden." });
      return;
    }
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Film mit dieser TMDB/IMDB-ID existiert bereits." });
      return;
    }
    console.error("[nzb] Update movie error:", err);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Films." });
  }
});

// DELETE /nzb/movies/:id — delete a movie and all its NZB files
router.delete("/movies/:id", async (req: AuthRequest, res: Response) => {
  try {
    await prisma.nzbMovie.delete({ where: { id: String(req.params.id) } });
    console.log(`[nzb] Movie deleted: ${String(req.params.id)}`);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(404).json({ error: "Film nicht gefunden." });
      return;
    }
    console.error("[nzb] Delete movie error:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Films." });
  }
});

// GET /nzb/movies/by-tmdb/:tmdbId — find movie by TMDB ID
router.get("/movies/by-tmdb/:tmdbId", async (req: AuthRequest, res: Response) => {
  try {
    const tmdbId = Number(String(req.params.tmdbId));
    if (isNaN(tmdbId)) {
      res.status(400).json({ error: "Ungültige TMDB-ID." });
      return;
    }

    const movie = await prisma.nzbMovie.findUnique({
      where: { tmdbId },
      include: { nzbFiles: { select: nzbFileSelect } },
    });

    if (!movie) {
      res.status(404).json({ error: "Film nicht gefunden." });
      return;
    }

    res.json({ movie: serializeMovieWithFiles(movie) });
  } catch (err) {
    console.error("[nzb] Find by TMDB error:", err);
    res.status(500).json({ error: "Fehler beim Suchen des Films." });
  }
});

// --- NZB File endpoints ---

// POST /nzb/files — add NZB file to a movie
router.post("/files", async (req: AuthRequest, res: Response) => {
  try {
    const { movieId, hash, originalFilename, fileSize, resolution, audioLanguages, subtitleLanguages, codec, source } = req.body;

    if (!movieId || !hash || !originalFilename) {
      res.status(400).json({ error: "movieId, hash und originalFilename sind erforderlich." });
      return;
    }

    // Verify movie exists
    const movie = await prisma.nzbMovie.findUnique({ where: { id: movieId } });
    if (!movie) {
      res.status(404).json({ error: "Film nicht gefunden." });
      return;
    }

    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId,
        hash,
        originalFilename,
        fileSize: fileSize ? BigInt(fileSize) : null,
        resolution: resolution || null,
        audioLanguages: audioLanguages || [],
        subtitleLanguages: subtitleLanguages || [],
        codec: codec || null,
        source: source || null,
      },
    });

    console.log(`[nzb] File added: ${hash} → ${movie.titleEn}`);
    res.status(201).json({ nzbFile: serializeNzbFile(nzbFile) });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "NZB-Datei mit diesem Hash existiert bereits." });
      return;
    }
    console.error("[nzb] Create file error:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen der NZB-Datei." });
  }
});

// PUT /nzb/files/:id — update NZB file metadata
router.put("/files/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { resolution, audioLanguages, subtitleLanguages, codec, source, status, brokenReason } = req.body;

    // Validate status if provided
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: "Status muss 'ok', 'broken' oder 'untested' sein." });
      return;
    }

    // Auto-clear brokenReason when status is not "broken"
    const effectiveBrokenReason = status && status !== "broken" ? null : brokenReason;

    const nzbFile = await prisma.nzbFile.update({
      where: { id: String(req.params.id) },
      data: {
        ...(resolution !== undefined && { resolution }),
        ...(audioLanguages !== undefined && { audioLanguages }),
        ...(subtitleLanguages !== undefined && { subtitleLanguages }),
        ...(codec !== undefined && { codec }),
        ...(source !== undefined && { source }),
        ...(status !== undefined && { status }),
        ...(effectiveBrokenReason !== undefined && { brokenReason: effectiveBrokenReason }),
      },
    });

    console.log(`[nzb] File updated: ${nzbFile.hash} (status: ${nzbFile.status})`);
    res.json({ nzbFile: serializeNzbFile(nzbFile) });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }
    console.error("[nzb] Update file error:", err);
    res.status(500).json({ error: "Fehler beim Aktualisieren der NZB-Datei." });
  }
});

// DELETE /nzb/files/:id — delete NZB file entry
router.delete("/files/:id", async (req: AuthRequest, res: Response) => {
  try {
    await prisma.nzbFile.delete({ where: { id: String(req.params.id) } });
    console.log(`[nzb] File deleted: ${String(req.params.id)}`);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }
    console.error("[nzb] Delete file error:", err);
    res.status(500).json({ error: "Fehler beim Löschen der NZB-Datei." });
  }
});

// GET /nzb/files/by-hash/:hash — find NZB file by hash
router.get("/files/by-hash/:hash", async (req: AuthRequest, res: Response) => {
  try {
    const nzbFile = await prisma.nzbFile.findUnique({
      where: { hash: String(req.params.hash) },
      include: { movie: true },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }

    res.json({ nzbFile: serializeNzbFile(nzbFile) });
  } catch (err) {
    console.error("[nzb] Find by hash error:", err);
    res.status(500).json({ error: "Fehler beim Suchen der NZB-Datei." });
  }
});

// PATCH /nzb/files/:id/status — update status (ok/broken/untested) with optional reason
router.patch("/files/:id/status", async (req: AuthRequest, res: Response) => {
  try {
    const { status, brokenReason } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: "Status muss 'ok', 'broken' oder 'untested' sein." });
      return;
    }

    const nzbFile = await prisma.nzbFile.update({
      where: { id: String(req.params.id) },
      data: {
        status,
        brokenReason: status === "broken" ? (brokenReason || null) : null,
      },
    });

    console.log(`[nzb] File status updated: ${nzbFile.hash} → ${status}`);
    res.json({ nzbFile: serializeNzbFile(nzbFile) });
  } catch (err: any) {
    if (err?.code === "P2025") {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }
    console.error("[nzb] Update status error:", err);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Status." });
  }
});

// --- NZB Import ---

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

/**
 * POST /nzb/import — Import an NZB file
 *
 * Flow:
 * 1. Receive NZB file upload
 * 2. Calculate SHA-256 hash
 * 3. Check if hash already exists → return existing
 * 4. Parse filename for metadata (resolution, languages, codec, source)
 * 5. Search TMDB for the movie
 * 6. Create or find NzbMovie
 * 7. Create NzbFile entry
 * 8. Return the created movie + file
 */
router.post("/import", upload.single("nzb"), async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "NZB-Datei ist erforderlich. Upload als 'nzb' Feld." });
      return;
    }

    const originalFilename = file.originalname;
    const hash = calculateHash(file.buffer);

    console.log(`[nzb-import] Processing: ${originalFilename} (hash: ${hash.slice(0, 12)}...)`);

    // Check if this exact file already exists
    const existing = await prisma.nzbFile.findUnique({
      where: { hash },
      include: { movie: true },
    });

    if (existing) {
      console.log(`[nzb-import] Already exists: ${hash.slice(0, 12)}... → ${existing.movie.titleEn}`);
      res.status(200).json({
        imported: false,
        message: "NZB-Datei existiert bereits.",
        movie: serializeMovieWithFiles({ ...existing.movie, nzbFiles: [existing] }),
        nzbFile: serializeNzbFile(existing),
      });
      return;
    }

    // Parse filename
    const parsed = parseNzbName(originalFilename);
    console.log(`[nzb-import] Parsed: title="${parsed.title}" year=${parsed.year} res=${parsed.resolution} langs=[${parsed.audioLanguages}] codec=${parsed.codec} source=${parsed.source}`);

    // Optional: movieId can be provided explicitly to skip TMDB lookup
    let movieId: string | null = req.body?.movieId || null;
    let movie: any = null;

    if (movieId) {
      // Use explicitly provided movie
      movie = await prisma.nzbMovie.findUnique({ where: { id: movieId } });
      if (!movie) {
        res.status(404).json({ error: "Angegebener Film nicht gefunden." });
        return;
      }
    } else {
      // TMDB lookup
      const tmdbResult = await searchTmdbMovie(parsed.title, parsed.year);

      if (tmdbResult.status === "found") {
        // Upsert: find existing or create new — race-condition safe
        movie = await prisma.nzbMovie.upsert({
          where: { tmdbId: tmdbResult.movie.tmdbId },
          update: {}, // Movie already exists, don't overwrite
          create: {
            tmdbId: tmdbResult.movie.tmdbId,
            imdbId: tmdbResult.movie.imdbId,
            titleDe: tmdbResult.movie.titleDe,
            titleEn: tmdbResult.movie.titleEn,
            description: tmdbResult.movie.description,
            year: tmdbResult.movie.year,
            posterPath: tmdbResult.movie.posterPath,
          },
        });
        console.log(`[nzb-import] Movie from TMDB: ${movie.titleEn} (${movie.id})`);
      } else if (tmdbResult.status === "error") {
        // TMDB error (network, rate limit, no API key) — don't create orphan movie
        console.warn(`[nzb-import] TMDB lookup failed: ${tmdbResult.reason}`);
        res.status(503).json({
          error: "TMDB-Lookup fehlgeschlagen. Film konnte nicht identifiziert werden.",
          reason: tmdbResult.reason,
          parsed,
        });
        return;
      } else {
        // Not found on TMDB — create movie from parsed name
        movie = await prisma.nzbMovie.create({
          data: {
            titleDe: parsed.title,
            titleEn: parsed.title,
            year: parsed.year,
          },
        });
        console.log(`[nzb-import] Created movie without TMDB: ${movie.titleEn} (${movie.id})`);
      }
    }

    // Create NZB file entry — handle hash race condition
    let nzbFile;
    try {
      nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash,
          originalFilename,
          fileSize: file.buffer.length ? BigInt(file.buffer.length) : null,
          resolution: parsed.resolution,
          audioLanguages: parsed.audioLanguages,
          codec: parsed.codec,
          source: parsed.source,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Race condition: another request created this file between our check and insert
        const existing = await prisma.nzbFile.findUnique({
          where: { hash },
          include: { movie: true },
        });
        res.status(200).json({
          imported: false,
          message: "NZB-Datei existiert bereits (gleichzeitiger Import).",
          movie: existing ? serializeMovieWithFiles({ ...existing.movie, nzbFiles: [existing] }) : null,
          nzbFile: existing ? serializeNzbFile(existing) : null,
        });
        return;
      }
      throw err;
    }

    console.log(`[nzb-import] Imported: ${hash.slice(0, 12)}... → ${movie.titleEn} (${parsed.resolution || "unknown"})`);

    // Reload movie with all files
    const fullMovie = await prisma.nzbMovie.findUnique({
      where: { id: movie.id },
      include: { nzbFiles: { select: nzbFileSelect } },
    });

    res.status(201).json({
      imported: true,
      movie: serializeMovieWithFiles(fullMovie),
      nzbFile: serializeNzbFile(nzbFile),
      parsed,
    });
  } catch (err) {
    console.error("[nzb-import] Error:", err);
    res.status(500).json({ error: "Fehler beim Importieren der NZB-Datei." });
  }
});

// --- Download Link ---

import { isS3Configured, generatePresignedUrl, EXPIRY_PRESETS, MAX_PRESIGNED_EXPIRY_SECONDS } from "../lib/s3.js";

// NOTE: NZB raw files are served by the openmedia-nzb service (separate microservice),
// not by this API. The download container fetches NZBs directly from openmedia-nzb.

// GET /nzb/files/:id/download-link — generate presigned download URL for an NZB file's media
router.get("/files/:id/download-link", async (req: AuthRequest, res: Response) => {
  try {
    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: String(req.params.id) },
      include: { movie: { select: { id: true, titleDe: true, titleEn: true, year: true } } },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }

    if (!nzbFile.s3Key) {
      res.status(422).json({ error: "Datei wurde noch nicht heruntergeladen (kein S3-Speicherort vorhanden)." });
      return;
    }

    if (!isS3Configured()) {
      res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
      return;
    }

    // Parse expiry — reject arrays and non-pure-digit strings
    const rawExpires = req.query.expires;
    if (Array.isArray(rawExpires)) {
      res.status(400).json({ error: "Nur ein expires-Wert erlaubt." });
      return;
    }
    const expiresParam = typeof rawExpires === "string" ? rawExpires : "7d";
    let expiresIn: number;
    if (Object.hasOwn(EXPIRY_PRESETS, expiresParam)) {
      expiresIn = EXPIRY_PRESETS[expiresParam];
    } else if (/^\d+$/.test(expiresParam)) {
      expiresIn = parseInt(expiresParam, 10);
      if (expiresIn < 60) {
        res.status(400).json({ error: "Ungültiger expires-Wert. Verwende 1h, 1d, 3d, 7d oder Sekunden (min 60)." });
        return;
      }
    } else {
      res.status(400).json({ error: "Ungültiger expires-Wert. Verwende 1h, 1d, 3d, 7d oder Sekunden (min 60)." });
      return;
    }

    const cappedExpires = Math.min(expiresIn, MAX_PRESIGNED_EXPIRY_SECONDS);
    const url = await generatePresignedUrl(nzbFile.s3Key, cappedExpires);
    const expiresAt = new Date(Date.now() + cappedExpires * 1000).toISOString();

    console.log(`[nzb] Download link generated: ${nzbFile.hash.slice(0, 12)}... (expires: ${expiresParam})`);

    // Update lastAccessedAt for LRU lifecycle tracking
    prisma.nzbFile.update({
      where: { id: String(req.params.id) },
      data: { lastAccessedAt: new Date() },
    }).catch(() => {}); // fire-and-forget

    res.json({
      url,
      expiresIn: cappedExpires,
      expiresAt,
      nzbFile: {
        id: nzbFile.id,
        hash: nzbFile.hash,
        s3Key: nzbFile.s3Key,
        resolution: nzbFile.resolution,
        fileExtension: nzbFile.fileExtension,
      },
      movie: nzbFile.movie,
    });
  } catch (err) {
    console.error("[nzb] Download link error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Download-Links." });
  }
});

export default router;
