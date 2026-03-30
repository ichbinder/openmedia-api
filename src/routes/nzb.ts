import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";

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
      include: { nzbFiles: true },
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
      include: { nzbFiles: true },
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

export default router;
