import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";
import { getAiSettings } from "../lib/ai-settings-service.js";
import { excludedKeys } from "../lib/candidates.js";
import { getTitleInfos, titleKey } from "../lib/title-info.js";
import { isRunning, requestRefresh } from "../lib/suggestion-run.js";
import type { Kind } from "../lib/title-meta.js";

const router = Router();
router.use(requireAuth);

const ROWS = [
  { key: "neu", title: () => "Neu für euch" },
  { key: "aehnlich", title: (because: string | null) => (because ? `Weil ihr „${because}“ mochtet` : "Ähnlich zu euren Favoriten") },
  { key: "serien", title: () => "Serien zum Eintauchen" },
  { key: "perlen", title: () => "Verpasste Perlen" },
];

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const running = await isRunning(userId);
    if (!(await getAiSettings(userId))?.hasKey) {
      res.json({ status: "no_key", createdAt: null, running, rows: [] });
      return;
    }
    const run = await prisma.suggestionRun.findFirst({
      where: { userId, status: "done" },
      orderBy: { startedAt: "desc" },
      include: { suggestions: { orderBy: { position: "asc" } } },
    });
    if (!run) {
      res.json({ status: "none", createdAt: null, running, rows: [] });
      return;
    }
    const excluded = await excludedKeys(userId);
    const open = run.suggestions.filter((s) => !excluded.has(titleKey({ kind: s.kind as Kind, tmdbId: s.tmdbId })));
    const infos = await getTitleInfos(open.map((s) => ({ kind: s.kind as Kind, tmdbId: s.tmdbId })));
    const rows = ROWS.flatMap(({ key, title }) => {
      const items = open
        .filter((s) => s.row === key)
        .flatMap((s) => {
          const info = infos.get(titleKey({ kind: s.kind as Kind, tmdbId: s.tmdbId }));
          return info
            ? [{ kind: s.kind, tmdbId: s.tmdbId, name: info.name, year: info.year, posterPath: info.posterPath, reason: s.reason }]
            : [];
        });
      return items.length ? [{ key, title: title(run.becauseName), items }] : [];
    });
    res.json({ status: "ready", createdAt: run.finishedAt?.toISOString() ?? null, running, rows });
  } catch (err) {
    console.error("[suggestions] Fehler:", err instanceof Error ? err.name : "unbekannt");
    res.status(500).json({ error: "Fehler beim Laden der Vorschläge." });
  }
});

router.post("/refresh", async (req: AuthRequest, res: Response) => {
  try {
    const outcome = await requestRefresh(req.user!.userId);
    if (outcome === "started") res.status(202).json({ ok: true });
    else if (outcome === "too_soon") res.status(429).json({ error: "Bitte warte noch ein paar Minuten." });
    else if (outcome === "running") res.status(409).json({ error: "Es läuft bereits ein Lauf." });
    else res.status(400).json({ error: "Kein Key gespeichert." });
  } catch (err) {
    console.error("[suggestions] Fehler:", err instanceof Error ? err.name : "unbekannt");
    res.status(500).json({ error: "Fehler beim Starten des Laufs." });
  }
});

router.post("/dismiss", async (req: AuthRequest, res: Response) => {
  const { kind, tmdbId } = req.body ?? {};
  if ((kind !== "movie" && kind !== "show") || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    res.status(400).json({ error: "kind muss movie oder show sein und tmdbId eine positive ganze Zahl." });
    return;
  }
  try {
    const userId = req.user!.userId;
    await prisma.titleDismissal.upsert({
      where: { userId_kind_tmdbId: { userId, kind, tmdbId } },
      create: { userId, kind, tmdbId },
      update: {},
    });
    res.status(204).end();
  } catch (err) {
    console.error("[suggestions] Fehler:", err instanceof Error ? err.name : "unbekannt");
    res.status(500).json({ error: "Fehler beim Ablehnen des Titels." });
  }
});

export default router;
