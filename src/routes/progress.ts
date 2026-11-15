import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { recordProgress } from "../lib/progress-service.js";

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

router.put("/", report);
router.post("/", report);

export default router;
