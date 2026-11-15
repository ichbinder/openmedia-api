import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { hideContinue, listContinue, nextForFile, recordProgress } from "../lib/progress-service.js";

const router = Router();

router.use(requireAuth);

async function report(req: AuthRequest, res: Response) {
  try {
    const { nzbFileId, positionSec, durationSec } = req.body ?? {};
    if (typeof nzbFileId !== "string" || typeof positionSec !== "number" || typeof durationSec !== "number") {
      res.status(400).json({ error: "nzbFileId, positionSec und durationSec sind erforderlich." });
      return;
    }

    const result = await recordProgress(req.user!.userId, nzbFileId, positionSec, durationSec);
    if (result.status === "invalid") {
      res.status(400).json({ error: "Ungültige Position oder Länge." });
    } else if (result.status === "not_found") {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
    } else {
      res.json({ progress: result.progress });
    }
  } catch (err) {
    console.error("[progress] Report error:", err);
    res.status(500).json({ error: "Fehler beim Speichern des Fortschritts." });
  }
}

router.get("/continue", async (req: AuthRequest, res: Response) => {
  try {
    res.json({ items: await listContinue(req.user!.userId) });
  } catch (err) {
    console.error("[progress] Continue error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Weiterschauen-Liste." });
  }
});

router.get("/next/:nzbFileId", async (req: AuthRequest, res: Response) => {
  try {
    const info = await nextForFile(req.user!.userId, String(req.params.nzbFileId));
    if (info === "not_found") {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }
    res.json(info);
  } catch (err) {
    console.error("[progress] Next error:", err);
    res.status(500).json({ error: "Fehler beim Ermitteln der nächsten Folge." });
  }
});

router.delete("/:kind/:tmdbId", async (req: AuthRequest, res: Response) => {
  try {
    const { kind } = req.params;
    const rawTmdbId = String(req.params.tmdbId);
    if ((kind !== "movie" && kind !== "show") || !/^[1-9]\d{0,9}$/.test(rawTmdbId)) {
      res.status(400).json({ error: "Ungültige Art oder TMDB-ID." });
      return;
    }
    res.json({ hidden: await hideContinue(req.user!.userId, kind, Number(rawTmdbId)) });
  } catch (err) {
    console.error("[progress] Hide error:", err);
    res.status(500).json({ error: "Fehler beim Entfernen des Eintrags." });
  }
});

router.put("/", report);
router.post("/", report);

export default router;
