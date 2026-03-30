import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { sendToSabnzbd, getSabnzbdStatus, getSabnzbdConfigSummary } from "../lib/sabnzbd.js";

const router = Router();

router.use(requireAuth);

const NZB_API_URL = process.env.NZB_API_URL || "http://localhost:4100";

// ---------------------------------------------------------------------------
// Valid status transitions for download jobs
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["queued", "provisioning", "downloading", "uploading", "completed", "failed"] as const;
type JobStatus = (typeof VALID_STATUSES)[number];

/** Map of allowed status transitions: current → allowed next statuses */
const STATUS_TRANSITIONS: Record<string, JobStatus[]> = {
  queued: ["provisioning", "failed"],
  provisioning: ["downloading", "failed"],
  downloading: ["uploading", "failed"],
  uploading: ["completed", "failed"],
  // Terminal states — no transitions out
  completed: [],
  failed: [],
};

function isValidTransition(from: string, to: string): boolean {
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to as JobStatus);
}

// ---------------------------------------------------------------------------
// NZB Storage helper
// ---------------------------------------------------------------------------

/**
 * Fetch NZB file content from openmedia-nzb by hash.
 */
async function fetchNzbFromStorage(hash: string, token: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const res = await fetch(`${NZB_API_URL}/files/${hash}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[download] Failed to fetch NZB ${hash.slice(0, 12)}... from storage: ${res.status}`);
      return null;
    }

    return await res.text();
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error(`[download] Storage timeout for ${hash.slice(0, 12)}...`);
    } else {
      console.error(`[download] Storage connection error: ${err.message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// SABnzbd status endpoints (legacy, kept for compatibility)
// ---------------------------------------------------------------------------

// GET /downloads/sabnzbd/status — check SABnzbd connection
router.get("/sabnzbd/status", async (_req: AuthRequest, res: Response) => {
  const status = await getSabnzbdStatus();
  res.json(status);
});

// GET /downloads/sabnzbd/config — check if SABnzbd is configured
router.get("/sabnzbd/config", (_req: AuthRequest, res: Response) => {
  res.json(getSabnzbdConfigSummary());
});

// POST /downloads/start — start a download by sending NZB to SABnzbd (legacy)
router.post("/start", async (req: AuthRequest, res: Response) => {
  try {
    const { nzbFileId } = req.body;

    if (!nzbFileId || typeof nzbFileId !== "string") {
      res.status(400).json({ error: "nzbFileId ist erforderlich (string)." });
      return;
    }

    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: nzbFileId },
      include: { movie: true },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }

    const authHeader = req.headers.authorization || "";
    const nzbContent = await fetchNzbFromStorage(nzbFile.hash, authHeader.replace("Bearer ", ""));

    if (!nzbContent) {
      res.status(502).json({ error: "NZB-Datei konnte nicht vom Storage geladen werden." });
      return;
    }

    const downloadName = `${nzbFile.movie.titleEn} (${nzbFile.movie.year || "unknown"}) [${nzbFile.resolution || "unknown"}]`;
    const result = await sendToSabnzbd(nzbContent, downloadName);

    if (!result.success) {
      console.error(`[download] SABnzbd rejected: ${result.error}`);
      res.status(502).json({ error: result.error });
      return;
    }

    console.log(`[download] Started: ${downloadName} → SABnzbd (nzo: ${result.nzoIds?.join(", ")})`);

    res.status(201).json({
      started: true,
      movie: { id: nzbFile.movie.id, titleDe: nzbFile.movie.titleDe, titleEn: nzbFile.movie.titleEn, year: nzbFile.movie.year },
      nzbFile: { id: nzbFile.id, hash: nzbFile.hash, resolution: nzbFile.resolution },
      sabnzbd: { nzoIds: result.nzoIds },
    });
  } catch (err) {
    console.error("[download] Start error:", err);
    res.status(500).json({ error: "Fehler beim Starten des Downloads." });
  }
});

// ---------------------------------------------------------------------------
// Download Job CRUD
// ---------------------------------------------------------------------------

/** Serialize BigInt fields for JSON response */
function serializeJob(job: any) {
  const nzbFile = job.nzbFile
    ? { ...job.nzbFile, fileSize: job.nzbFile.fileSize?.toString() ?? null }
    : undefined;
  return { ...job, nzbFile };
}

// POST /downloads/jobs — create a download job
router.post("/jobs", async (req: AuthRequest, res: Response) => {
  try {
    const { nzbFileId } = req.body;

    if (!nzbFileId || typeof nzbFileId !== "string") {
      res.status(400).json({ error: "nzbFileId ist erforderlich (string)." });
      return;
    }

    // Verify NZB file exists
    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: nzbFileId },
      include: { movie: true },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB-Datei nicht gefunden." });
      return;
    }

    // Atomic check-and-create inside a transaction to prevent race conditions
    // (two concurrent requests for the same nzbFileId)
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const existingJob = await tx.downloadJob.findFirst({
          where: {
            nzbFileId,
            status: { in: ["queued", "provisioning", "downloading", "uploading"] },
          },
        });

        if (existingJob) {
          return { conflict: true as const, existingJob };
        }

        const job = await tx.downloadJob.create({
          data: { nzbFileId },
          include: {
            nzbFile: {
              include: { movie: true },
            },
          },
        });

        return { conflict: false as const, job };
      }, { isolationLevel: "Serializable" });
    } catch (err: any) {
      // Serialization failure from concurrent transaction — treat as conflict
      if (err?.code === "P2034" || err?.code === "40001") {
        res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
        return;
      }
      throw err;
    }

    if (result.conflict) {
      res.status(409).json({
        error: "Es läuft bereits ein Download für diese Datei.",
        existingJobId: result.existingJob.id,
        existingStatus: result.existingJob.status,
      });
      return;
    }

    console.log(`[download-job] Created: ${result.job.id} for ${nzbFile.movie.titleEn} (${nzbFile.hash.slice(0, 12)}...)`);

    res.status(201).json({ job: serializeJob(result.job) });
  } catch (err) {
    console.error("[download-job] Create error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Download-Jobs." });
  }
});

// GET /downloads/jobs — list download jobs
router.get("/jobs", async (req: AuthRequest, res: Response) => {
  try {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

    // Validate status filter if provided
    if (statusFilter && !VALID_STATUSES.includes(statusFilter as JobStatus)) {
      res.status(400).json({
        error: `Ungültiger Status. Erlaubt: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    const jobs = await prisma.downloadJob.findMany({
      where: statusFilter ? { status: statusFilter } : undefined,
      include: {
        nzbFile: {
          include: { movie: { select: { id: true, titleDe: true, titleEn: true, year: true, posterPath: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({ jobs: jobs.map(serializeJob) });
  } catch (err) {
    console.error("[download-job] List error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Download-Jobs." });
  }
});

// GET /downloads/jobs/:id — get a single download job
router.get("/jobs/:id", async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: {
        nzbFile: {
          include: { movie: true },
        },
      },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    res.json({ job: serializeJob(job) });
  } catch (err) {
    console.error("[download-job] Get error:", err);
    res.status(500).json({ error: "Fehler beim Laden des Download-Jobs." });
  }
});

// PATCH /downloads/jobs/:id/status — update job status (callback from VPS)
router.patch("/jobs/:id/status", async (req: AuthRequest, res: Response) => {
  try {
    const { status, error: errorMsg, progress, s3Key, s3Bucket, fileExtension, hetznerServerId, hetznerServerIp } = req.body;

    if (!status || typeof status !== "string") {
      res.status(400).json({ error: "status ist erforderlich (string)." });
      return;
    }

    if (!VALID_STATUSES.includes(status as JobStatus)) {
      res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${VALID_STATUSES.join(", ")}` });
      return;
    }

    // Get current job
    const currentJob = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
    });

    if (!currentJob) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    // Validate status transition
    if (!isValidTransition(currentJob.status, status)) {
      res.status(422).json({
        error: `Ungültiger Status-Übergang: ${currentJob.status} → ${status}`,
        currentStatus: currentJob.status,
        allowedTransitions: STATUS_TRANSITIONS[currentJob.status] || [],
      });
      return;
    }

    // Build update data with input validation
    const parsedProgress = progress !== undefined ? Number(progress) : undefined;
    const parsedServerId = hetznerServerId !== undefined ? Number(hetznerServerId) : undefined;

    if (parsedProgress !== undefined && (!Number.isFinite(parsedProgress) || !Number.isInteger(parsedProgress) || parsedProgress < 0 || parsedProgress > 100)) {
      res.status(400).json({ error: "progress muss eine ganze Zahl zwischen 0 und 100 sein." });
      return;
    }

    if (parsedServerId !== undefined && (isNaN(parsedServerId) || !Number.isInteger(parsedServerId))) {
      res.status(400).json({ error: "hetznerServerId muss eine ganze Zahl sein." });
      return;
    }

    const updateData: any = {
      status,
      ...(parsedProgress !== undefined && { progress: Math.min(Math.max(parsedProgress, 0), 100) }),
      ...(errorMsg !== undefined && { error: errorMsg }),
      ...(parsedServerId !== undefined && { hetznerServerId: parsedServerId }),
      ...(hetznerServerIp !== undefined && { hetznerServerIp: String(hetznerServerIp) }),
    };

    // Set timing fields based on status
    if (status === "provisioning" && !currentJob.startedAt) {
      updateData.startedAt = new Date();
    }
    if (status === "completed" || status === "failed") {
      updateData.completedAt = new Date();
    }
    if (status === "completed") {
      updateData.progress = 100;
    }

    // On completed: require s3Key and update both job + NzbFile atomically
    if (status === "completed") {
      if (!s3Key || typeof s3Key !== "string") {
        res.status(400).json({ error: "s3Key ist erforderlich wenn Status 'completed' gesetzt wird." });
        return;
      }

      // Compare-and-swap: only update if status hasn't changed concurrently
      const updateResult = await prisma.$transaction(async (tx) => {
        const casResult = await tx.downloadJob.updateMany({
          where: { id: String(req.params.id), status: currentJob.status },
          data: updateData,
        });

        if (casResult.count === 0) {
          return { conflict: true as const };
        }

        await tx.nzbFile.update({
          where: { id: currentJob.nzbFileId },
          data: {
            s3Key: String(s3Key),
            s3Bucket: s3Bucket ? String(s3Bucket) : (process.env.S3_BUCKET || null),
            fileExtension: fileExtension ? String(fileExtension) : null,
            downloadedAt: new Date(),
          },
        });

        return { conflict: false as const };
      });

      if (updateResult.conflict) {
        res.status(409).json({ error: "Status wurde zwischenzeitlich geändert (Konflikt)." });
        return;
      }

      console.log(`[download-job] Completed: ${currentJob.id} → s3://${s3Bucket || process.env.S3_BUCKET}/${s3Key}`);

      // Re-fetch to include updated NzbFile in response
      const fullJob = await prisma.downloadJob.findUnique({
        where: { id: currentJob.id },
        include: { nzbFile: { include: { movie: true } } },
      });

      res.json({ job: serializeJob(fullJob) });
      return;
    }

    // Non-completed status: compare-and-swap update
    const casResult = await prisma.downloadJob.updateMany({
      where: { id: String(req.params.id), status: currentJob.status },
      data: updateData,
    });

    if (casResult.count === 0) {
      res.status(409).json({ error: "Status wurde zwischenzeitlich geändert (Konflikt)." });
      return;
    }

    // Re-fetch with includes for response
    const updatedJob = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: { nzbFile: { include: { movie: true } } },
    });

    console.log(`[download-job] Status update: ${currentJob.id} → ${status}`);

    res.json({ job: serializeJob(updatedJob) });
  } catch (err) {
    console.error("[download-job] Status update error:", err);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Status." });
  }
});

// DELETE /downloads/jobs/:id — delete a job (only if not active)
router.delete("/jobs/:id", async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    // Don't allow deleting active jobs
    const activeStatuses = ["provisioning", "downloading", "uploading"];
    if (activeStatuses.includes(job.status)) {
      res.status(422).json({
        error: `Aktiver Job kann nicht gelöscht werden (Status: ${job.status}).`,
        status: job.status,
      });
      return;
    }

    await prisma.downloadJob.delete({ where: { id: job.id } });
    console.log(`[download-job] Deleted: ${job.id}`);

    res.json({ success: true });
  } catch (err) {
    console.error("[download-job] Delete error:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Download-Jobs." });
  }
});

export default router;
