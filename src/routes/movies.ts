import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { listMovieCandidates, requestMovie } from "../lib/movie-requests.js";
import { handleIndexerError } from "./indexer-errors.js";

const router = Router();
router.use(requireAuth);

const POSITIVE_INT = /^[1-9]\d{0,9}$/;
const KEY_PATTERN = /^(file:[0-9a-f-]{36}|guid:[a-f0-9]{32})$/;
const FALLBACK_MESSAGE = "Interner Fehler bei der Film-Anfrage.";

function parsePositiveInt(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && POSITIVE_INT.test(text) ? Number(text) : null;
}

router.get("/candidates", async (req: AuthRequest, res: Response) => {
  const tmdbId = parsePositiveInt(req.query.tmdbId);
  if (tmdbId === null) {
    res.status(400).json({ error: "Ungültige Angaben: tmdbId." });
    return;
  }

  try {
    res.json(await listMovieCandidates(tmdbId));
  } catch (err) {
    handleIndexerError(err, res, "movies candidates", FALLBACK_MESSAGE);
  }
});

router.post("/requests", async (req: AuthRequest, res: Response) => {
  const { tmdbId, key, confirmed, manual } = req.body ?? {};
  const tmdb = parsePositiveInt(tmdbId);
  if (tmdb === null || typeof key !== "string" || !KEY_PATTERN.test(key)) {
    res.status(400).json({ error: "Ungültige Angaben: tmdbId oder key." });
    return;
  }

  try {
    const outcome = await requestMovie(req.user!.userId, tmdb, key, {
      confirmed: confirmed === true,
      manual: manual === true,
    });
    switch (outcome.status) {
      case "ready":
      case "downloading":
        res.json({ status: outcome.status, nzbFileId: outcome.nzbFileId });
        return;
      case "confirm_required":
        res.status(409).json({ reason: "confirm_required", group: outcome.group });
        return;
      case "budget":
        res.status(429).json({ reason: "budget", error: "Tageslimit erreicht — morgen wieder" });
        return;
      case "candidate_gone":
        res.status(404).json({ reason: "candidate_gone", error: "Version nicht mehr verfügbar" });
        return;
      case "failed":
        res.status(409).json({ reason: "failed", error: "Keine passende Version konnte geladen werden" });
        return;
    }
  } catch (err) {
    handleIndexerError(err, res, "movies request", FALLBACK_MESSAGE);
  }
});

export default router;
