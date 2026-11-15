import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { getMeta } from "../lib/meta-service.js";
import { META_RULES, type Kind } from "../lib/title-meta.js";

const router = Router();
router.use(requireAuth);

const isValidItem = (i: unknown): i is { kind: Kind; tmdbId: number } => {
  const item = i as { kind?: unknown; tmdbId?: unknown } | null;
  return (
    (item?.kind === "movie" || item?.kind === "show") &&
    Number.isInteger(item.tmdbId) &&
    (item.tmdbId as number) > 0
  );
};

router.post("/", async (req: AuthRequest, res: Response) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > META_RULES.MAX_ITEMS) {
    res.status(400).json({ error: `items muss 1 bis ${META_RULES.MAX_ITEMS} Einträge enthalten.` });
    return;
  }
  if (!items.every(isValidItem)) {
    res.status(400).json({ error: "Jeder Eintrag braucht kind (movie oder show) und eine positive ganze tmdbId." });
    return;
  }
  try {
    res.json({ items: await getMeta(items.map(({ kind, tmdbId }) => ({ kind, tmdbId }))) });
  } catch (err) {
    console.error("[meta] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Laden der Metadaten." });
  }
});

export default router;
