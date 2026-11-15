import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";
import { getAiKey, getAiSettings, saveAiSettings } from "../lib/ai-settings-service.js";
import { chatJson } from "../lib/openrouter.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const settings = await getAiSettings(userId);
    const run = await prisma.suggestionRun.findFirst({ where: { userId }, orderBy: { startedAt: "desc" } });
    res.json({
      model: settings?.model ?? "",
      hasKey: settings?.hasKey ?? false,
      lastRun: run ? { status: run.status, finishedAt: run.finishedAt, error: run.error } : null,
    });
  } catch (err) {
    console.error("[ai-settings] Fehler:", err);
    res.status(500).json({ error: "Fehler beim Laden der KI-Einstellungen." });
  }
});

router.put("/", async (req: AuthRequest, res: Response) => {
  try {
    const { model, apiKey } = req.body ?? {};
    if (typeof model !== "string" || model.length < 1 || model.length > 100) {
      res.status(400).json({ error: "Modell muss 1 bis 100 Zeichen lang sein." });
      return;
    }
    if (apiKey !== undefined && typeof apiKey !== "string") {
      res.status(400).json({ error: "Ungültiger Key." });
      return;
    }
    await saveAiSettings(req.user!.userId, { model, apiKey });
    res.json({ model, hasKey: (await getAiSettings(req.user!.userId))!.hasKey });
  } catch (err) {
    console.error("[ai-settings] Fehler:", err instanceof Error ? err.message : "unbekannt");
    res.status(500).json({ error: "Fehler beim Speichern der KI-Einstellungen." });
  }
});

router.post("/test", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const key = await getAiKey(userId);
    const settings = await getAiSettings(userId);
    if (!key || !settings) {
      res.json({ ok: false, error: "Kein Key gespeichert." });
      return;
    }
    const result = await chatJson(key, settings.model, [{ role: "user", content: 'Antworte mit {"ok":true}' }], 30_000);
    res.json(result.ok ? { ok: true } : { ok: false, error: result.error });
  } catch (err) {
    console.error("[ai-settings] Fehler:", err instanceof Error ? err.message : "unbekannt");
    res.status(500).json({ error: "Fehler beim Testen der KI-Einstellungen." });
  }
});

export default router;
