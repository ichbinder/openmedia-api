import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { sendToSabnzbd, getSabnzbdStatus, isSabnzbdConfigured } from "../lib/sabnzbd.js";

const router = Router();

router.use(requireAuth);

const NZB_API_URL = process.env.NZB_API_URL || "http://localhost:4100";

/**
 * Fetch NZB file content from openmedia-nzb by hash.
 */
async function fetchNzbFromStorage(hash: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${NZB_API_URL}/files/${hash}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[download] Failed to fetch NZB ${hash.slice(0, 12)}... from storage: ${res.status}`);
      return null;
    }

    return await res.text();
  } catch (err: any) {
    console.error(`[download] Storage connection error: ${err.message}`);
    return null;
  }
}

// GET /downloads/sabnzbd/status — check SABnzbd connection
router.get("/sabnzbd/status", async (_req: AuthRequest, res: Response) => {
  const status = await getSabnzbdStatus();
  res.json(status);
});

// GET /downloads/sabnzbd/config — check if SABnzbd is configured (no secrets exposed)
router.get("/sabnzbd/config", (_req: AuthRequest, res: Response) => {
  const configured = isSabnzbdConfigured();
  res.json({
    configured,
    url: configured ? process.env.SABNZBD_URL : null,
    category: process.env.SABNZBD_CATEGORY || null,
  });
});

// POST /downloads/start — start a download by sending NZB to SABnzbd
router.post("/start", async (req: AuthRequest, res: Response) => {
  try {
    const { nzbFileId } = req.body;

    if (!nzbFileId) {
      res.status(400).json({ error: "nzbFileId ist erforderlich." });
      return;
    }

    // Get NZB file info from DB
    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: nzbFileId },
      include: { movie: true },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }

    // Get the auth token from the request to forward to openmedia-nzb
    const authHeader = req.headers.authorization || "";

    // Fetch NZB content from openmedia-nzb
    const nzbContent = await fetchNzbFromStorage(nzbFile.hash, authHeader.replace("Bearer ", ""));

    if (!nzbContent) {
      res.status(502).json({ error: "NZB-Datei konnte nicht vom Storage geladen werden." });
      return;
    }

    // Build a readable filename for SABnzbd
    const downloadName = `${nzbFile.movie.titleEn} (${nzbFile.movie.year || "unknown"}) [${nzbFile.resolution || "unknown"}]`;

    // Send to SABnzbd
    const result = await sendToSabnzbd(nzbContent, downloadName);

    if (!result.success) {
      console.error(`[download] SABnzbd rejected: ${result.error}`);
      res.status(502).json({ error: result.error });
      return;
    }

    console.log(`[download] Started: ${downloadName} → SABnzbd (nzo: ${result.nzoIds?.join(", ")})`);

    res.status(201).json({
      started: true,
      movie: {
        id: nzbFile.movie.id,
        titleDe: nzbFile.movie.titleDe,
        titleEn: nzbFile.movie.titleEn,
        year: nzbFile.movie.year,
      },
      nzbFile: {
        id: nzbFile.id,
        hash: nzbFile.hash,
        resolution: nzbFile.resolution,
      },
      sabnzbd: {
        nzoIds: result.nzoIds,
      },
    });
  } catch (err) {
    console.error("[download] Start error:", err);
    res.status(500).json({ error: "Fehler beim Starten des Downloads." });
  }
});

export default router;
