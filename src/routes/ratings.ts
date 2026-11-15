import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { deleteRating, getRating, listRatings, personIds, saveRating } from "../lib/rating-service.js";
import { parseRatingInput } from "../lib/taste.js";
import type { Kind } from "../lib/title-meta.js";

const router = Router();
router.use(requireAuth);

const parseKey = (req: AuthRequest): { kind: Kind; tmdbId: number } | null => {
  const { kind, tmdbId } = req.params;
  const id = Number(tmdbId);
  if ((kind !== "movie" && kind !== "show") || !Number.isInteger(id) || id <= 0) return null;
  return { kind, tmdbId: id };
};

const BAD_KEY = "kind muss movie oder show sein und tmdbId eine positive ganze Zahl.";

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    res.json({ items: await listRatings(req.user!.userId) });
  } catch (err) {
    console.error("[ratings] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Laden der Bewertungen." });
  }
});

router.get("/:kind/:tmdbId", async (req: AuthRequest, res: Response) => {
  const key = parseKey(req);
  if (!key) {
    res.status(400).json({ error: BAD_KEY });
    return;
  }
  try {
    const rating = await getRating(req.user!.userId, key.kind, key.tmdbId);
    if (!rating) {
      res.status(404).json({ error: "Keine Bewertung vorhanden." });
      return;
    }
    res.json(rating);
  } catch (err) {
    console.error("[ratings] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Laden der Bewertung." });
  }
});

router.put("/:kind/:tmdbId", async (req: AuthRequest, res: Response) => {
  const key = parseKey(req);
  if (!key) {
    res.status(400).json({ error: BAD_KEY });
    return;
  }
  try {
    const input = parseRatingInput(req.body, await personIds(req.user!.userId));
    if ("error" in input) {
      res.status(400).json({ error: input.error });
      return;
    }
    res.json(await saveRating(req.user!.userId, key.kind, key.tmdbId, input));
  } catch (err) {
    console.error("[ratings] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Speichern der Bewertung." });
  }
});

router.delete("/:kind/:tmdbId", async (req: AuthRequest, res: Response) => {
  const key = parseKey(req);
  if (!key) {
    res.status(400).json({ error: BAD_KEY });
    return;
  }
  try {
    const deleted = await deleteRating(req.user!.userId, key.kind, key.tmdbId);
    if (!deleted) {
      res.status(404).json({ error: "Keine Bewertung vorhanden." });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error("[ratings] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Löschen der Bewertung." });
  }
});

export default router;
