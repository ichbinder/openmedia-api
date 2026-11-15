import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { personIds } from "../lib/rating-service.js";
import { getTaste, saveTaste } from "../lib/taste-service.js";
import { parseTasteInput } from "../lib/taste.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    res.json(await getTaste(req.user!.userId));
  } catch (err) {
    console.error("[taste] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Laden des Geschmacksprofils." });
  }
});

router.put("/", async (req: AuthRequest, res: Response) => {
  try {
    const input = parseTasteInput(req.body, await personIds(req.user!.userId));
    if ("error" in input) {
      res.status(400).json({ error: input.error });
      return;
    }
    res.json(await saveTaste(req.user!.userId, input));
  } catch (err) {
    console.error("[taste] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Speichern des Geschmacksprofils." });
  }
});

export default router;
