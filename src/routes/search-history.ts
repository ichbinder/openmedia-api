import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

/** Maximum number of search history entries per user */
const MAX_HISTORY_SIZE = 50;

// GET /search-history — list recent search history
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, MAX_HISTORY_SIZE);

    const items = await prisma.searchHistory.findMany({
      where: { userId: req.user!.userId },
      orderBy: { searchedAt: "desc" },
      take: limit,
    });

    res.json({ items });
  } catch (err) {
    console.error("[search-history] List error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Suchhistorie." });
  }
});

// POST /search-history — add movie to search history
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { movieId, title, posterPath, voteAverage, releaseDate } = req.body;

    if (!movieId || !title) {
      res.status(400).json({ error: "movieId und title sind erforderlich." });
      return;
    }

    // Upsert — updates searchedAt if already exists
    const item = await prisma.searchHistory.upsert({
      where: {
        userId_movieId: {
          userId: req.user!.userId,
          movieId: Number(movieId),
        },
      },
      update: {
        searchedAt: new Date(),
        title,
        posterPath: posterPath ?? null,
        voteAverage: Number(voteAverage) || 0,
        releaseDate: releaseDate ?? "",
      },
      create: {
        userId: req.user!.userId,
        movieId: Number(movieId),
        title,
        posterPath: posterPath ?? null,
        voteAverage: Number(voteAverage) || 0,
        releaseDate: releaseDate ?? "",
      },
    });

    // Trim old entries beyond MAX_HISTORY_SIZE
    const count = await prisma.searchHistory.count({
      where: { userId: req.user!.userId },
    });

    if (count > MAX_HISTORY_SIZE) {
      const oldest = await prisma.searchHistory.findMany({
        where: { userId: req.user!.userId },
        orderBy: { searchedAt: "asc" },
        take: count - MAX_HISTORY_SIZE,
        select: { id: true },
      });

      if (oldest.length > 0) {
        await prisma.searchHistory.deleteMany({
          where: { id: { in: oldest.map((o) => o.id) } },
        });
      }
    }

    res.status(201).json({ item });
  } catch (err) {
    console.error("[search-history] Add error:", err);
    res.status(500).json({ error: "Fehler beim Speichern in der Suchhistorie." });
  }
});

// DELETE /search-history — clear all search history
router.delete("/", async (req: AuthRequest, res: Response) => {
  try {
    await prisma.searchHistory.deleteMany({
      where: { userId: req.user!.userId },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[search-history] Clear error:", err);
    res.status(500).json({ error: "Fehler beim Löschen der Suchhistorie." });
  }
});

// DELETE /search-history/:movieId — remove single movie from history
router.delete("/:movieId", async (req: AuthRequest, res: Response) => {
  try {
    const movieId = Number(req.params.movieId);

    if (isNaN(movieId)) {
      res.status(400).json({ error: "Ungültige movieId." });
      return;
    }

    await prisma.searchHistory.deleteMany({
      where: {
        userId: req.user!.userId,
        movieId,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error("[search-history] Remove error:", err);
    res.status(500).json({ error: "Fehler beim Entfernen aus der Suchhistorie." });
  }
});

export default router;
