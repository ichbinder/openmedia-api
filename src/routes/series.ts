import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { rankEpisodeCandidates, requestEpisodes } from "../lib/episode-requests.js";
import { handleIndexerError } from "./indexer-errors.js";

const router = Router();
router.use(requireAuth);

const GUID_PATTERN = /^[a-f0-9]{32}$/;
const POSITIVE_INT = /^[1-9]\d{0,9}$/;
const NON_NEGATIVE_INT = /^(0|[1-9]\d{0,9})$/;

function parseInt_(value: unknown, pattern: RegExp): number | null {
  return typeof value === "string" && pattern.test(value) ? Number(value) : null;
}

function parseBodyInt(value: unknown, pattern: RegExp): number | null {
  return typeof value === "number" && Number.isInteger(value) ? parseInt_(String(value), pattern) : null;
}

router.post("/requests", async (req: AuthRequest, res: Response) => {
  const { tmdbId, season, episode, guid } = req.body ?? {};
  const tmdb = parseBodyInt(tmdbId, POSITIVE_INT);
  const seasonNumber = parseBodyInt(season, NON_NEGATIVE_INT);
  const episodeNumber = episode === undefined ? undefined : parseBodyInt(episode, POSITIVE_INT);
  const guidValid =
    guid === undefined || (episodeNumber !== undefined && typeof guid === "string" && GUID_PATTERN.test(guid));

  if (tmdb === null || seasonNumber === null || episodeNumber === null || !guidValid) {
    res.status(400).json({ error: "Ungültige Angaben: tmdbId, season, episode oder guid." });
    return;
  }

  try {
    const requests = await requestEpisodes(req.user!.userId, tmdb, seasonNumber, episodeNumber ?? undefined, guid);
    res.json({ requests });
  } catch (err) {
    handleIndexerError(err, res, "series request", "Interner Fehler bei der Serien-Anfrage.");
  }
});

router.get("/candidates", async (req: AuthRequest, res: Response) => {
  const tmdb = parseInt_(req.query.tmdbId, POSITIVE_INT);
  const season = parseInt_(req.query.season, NON_NEGATIVE_INT);
  const episode = parseInt_(req.query.episode, POSITIVE_INT);
  if (tmdb === null || season === null || episode === null) {
    res.status(400).json({ error: "Ungültige Angaben: tmdbId, season oder episode." });
    return;
  }

  try {
    const ranked = await rankEpisodeCandidates(tmdb, season, episode);
    res.json({
      candidates: ranked.map((r) => ({
        guid: r.guid,
        title: r.title,
        qualityTier: r.qualityTier,
        sizeBytes: r.size,
        gbPerHour: r.gbPerHour,
        inTargetBand: r.inTargetBand,
        germanSubtitles: r.germanSubtitles,
        audioDescription: r.audioDescription,
        releaseType: r.releaseType,
        languageSource: r.languageSource,
      })),
    });
  } catch (err) {
    handleIndexerError(err, res, "series candidates", "Interner Fehler bei der Serien-Anfrage.");
  }
});

export default router;
