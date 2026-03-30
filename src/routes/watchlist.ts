import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";

const router = Router();

// All watchlist routes require auth
router.use(requireAuth);

// GET /watchlist — list user's watchlist
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.watchlistItem.findMany({
      where: { userId: req.user!.userId },
      orderBy: { addedAt: "desc" },
    });

    res.json({ items });
  } catch (err) {
    console.error("[watchlist] List error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Watchlist." });
  }
});

// POST /watchlist — add movie to watchlist
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const { movieId, title, posterPath, voteAverage, releaseDate } = req.body;

    if (!movieId || !title) {
      res.status(400).json({ error: "movieId und title sind erforderlich." });
      return;
    }

    // Upsert — idempotent add
    const item = await prisma.watchlistItem.upsert({
      where: {
        userId_movieId: {
          userId: req.user!.userId,
          movieId: Number(movieId),
        },
      },
      update: {}, // Already exists, no change
      create: {
        userId: req.user!.userId,
        movieId: Number(movieId),
        title,
        posterPath: posterPath ?? null,
        voteAverage: Number(voteAverage) || 0,
        releaseDate: releaseDate ?? "",
      },
    });

    console.log(`[watchlist] Added movie ${movieId} for user ${req.user!.userId}`);
    res.status(201).json({ item });
  } catch (err) {
    console.error("[watchlist] Add error:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen zur Watchlist." });
  }
});

// DELETE /watchlist/:movieId — remove movie from watchlist
router.delete("/:movieId", async (req: AuthRequest, res: Response) => {
  try {
    const movieId = Number(req.params.movieId);

    if (isNaN(movieId)) {
      res.status(400).json({ error: "Ungültige movieId." });
      return;
    }

    await prisma.watchlistItem.deleteMany({
      where: {
        userId: req.user!.userId,
        movieId,
      },
    });

    console.log(`[watchlist] Removed movie ${movieId} for user ${req.user!.userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[watchlist] Remove error:", err);
    res.status(500).json({ error: "Fehler beim Entfernen aus der Watchlist." });
  }
});

// GET /watchlist/check/:movieId — check if movie is in watchlist
router.get("/check/:movieId", async (req: AuthRequest, res: Response) => {
  try {
    const movieId = Number(req.params.movieId);

    if (isNaN(movieId)) {
      res.status(400).json({ error: "Ungültige movieId." });
      return;
    }

    const item = await prisma.watchlistItem.findUnique({
      where: {
        userId_movieId: {
          userId: req.user!.userId,
          movieId,
        },
      },
    });

    res.json({ inWatchlist: !!item });
  } catch (err) {
    console.error("[watchlist] Check error:", err);
    res.status(500).json({ error: "Fehler beim Prüfen der Watchlist." });
  }
});

export default router;
