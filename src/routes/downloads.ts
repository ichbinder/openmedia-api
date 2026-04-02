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
          data: { nzbFileId, userId: req.user?.userId || null },
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

    // Auto-provision: start download in background
    // (after response is sent to client)
    if (process.env.AUTO_PROVISION !== "false") {
      import("../lib/provisioner.js").then(({ provisionDownload }) => {
        provisionDownload(result.job.id).catch((err) => {
          console.error("[download-job] Auto-provision failed:", err);
        });
      });
    }
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
    // Allow same-status updates for progress/metadata changes
    if (status !== currentJob.status && !isValidTransition(currentJob.status, status)) {
      res.status(422).json({
        error: `Ungültiger Status-Übergang: ${currentJob.status} → ${status}`,
        currentStatus: currentJob.status,
        allowedTransitions: STATUS_TRANSITIONS[currentJob.status] || [],
      });
      return;
    }

    // For same-status updates: require at least one field to change
    if (status === currentJob.status) {
      const hasFieldUpdate = progress !== undefined || hetznerServerId !== undefined || hetznerServerIp !== undefined || errorMsg !== undefined;
      if (!hasFieldUpdate) {
        res.status(422).json({ error: "Keine Änderung angegeben." });
        return;
      }
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
      ...(errorMsg !== undefined && typeof errorMsg === "string" && { error: errorMsg.slice(0, 2000) }),
      ...(parsedServerId !== undefined && { hetznerServerId: parsedServerId }),
      ...(hetznerServerIp !== undefined && typeof hetznerServerIp === "string" && { hetznerServerIp }),
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

      const effectiveBucket = s3Bucket ? String(s3Bucket) : process.env.S3_BUCKET;
      if (!effectiveBucket) {
        res.status(400).json({ error: "s3Bucket ist erforderlich (weder im Request noch als S3_BUCKET konfiguriert)." });
        return;
      }

      // Validate S3 metadata
      if (!/^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(effectiveBucket)) {
        res.status(400).json({ error: "Ungültiger S3-Bucket-Name." });
        return;
      }

      if (fileExtension !== undefined && fileExtension !== null) {
        const ext = String(fileExtension);
        if (!/^\.[a-zA-Z0-9]{1,10}$/.test(ext)) {
          res.status(400).json({ error: "Ungültige Dateiendung (erwartet z.B. '.mkv', '.mp4')." });
          return;
        }
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
            s3Bucket: effectiveBucket,
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

      console.log(`[download-job] Completed: ${currentJob.id} → s3://${effectiveBucket}/${s3Key}`);

      // Auto-add to user's library if job has a userId
      if (currentJob.userId) {
        try {
          await prisma.userLibrary.upsert({
            where: { userId_nzbFileId: { userId: currentJob.userId, nzbFileId: currentJob.nzbFileId } },
            create: { userId: currentJob.userId, nzbFileId: currentJob.nzbFileId },
            update: { removedAt: null, addedAt: new Date() },  // re-add if previously removed
          });
          console.log(`[library] Auto-added to library: user ${currentJob.userId.slice(0, 8)}... → ${currentJob.nzbFileId.slice(0, 8)}...`);
        } catch (libErr) {
          console.error("[library] Auto-add failed:", libErr);
        }
      }

      // Re-fetch to include updated NzbFile in response
      const fullJob = await prisma.downloadJob.findUnique({
        where: { id: currentJob.id },
        include: { nzbFile: { include: { movie: true } } },
      });

      if (!fullJob) {
        res.status(404).json({ error: "Job wurde zwischenzeitlich gelöscht." });
        return;
      }

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

    if (!updatedJob) {
      res.status(404).json({ error: "Job wurde zwischenzeitlich gelöscht." });
      return;
    }

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

    // Conditional delete: CAS-style to prevent deleting a job that became active
    const activeStatuses = ["provisioning", "downloading", "uploading"];
    const deleteResult = await prisma.downloadJob.deleteMany({
      where: {
        id: job.id,
        status: { notIn: activeStatuses },
      },
    });

    if (deleteResult.count === 0) {
      res.status(422).json({
        error: `Job-Status hat sich geändert und kann nicht gelöscht werden.`,
      });
      return;
    }

    console.log(`[download-job] Deleted: ${job.id}`);

    res.json({ success: true });
  } catch (err) {
    console.error("[download-job] Delete error:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Download-Jobs." });
  }
});

// ---------------------------------------------------------------------------
// VPS Management
// ---------------------------------------------------------------------------

import {
  isHetznerConfigured,
  createServer,
  deleteServer,
  listServers,
  findZombieServers,
  generateCloudInit,
} from "../lib/hetzner.js";

// GET /downloads/jobs/:id/link — generate presigned download URL for a completed job
router.get("/jobs/:id/link", async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: {
        nzbFile: {
          include: { movie: { select: { id: true, titleDe: true, titleEn: true, year: true } } },
        },
      },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    if (job.status !== "completed") {
      res.status(422).json({
        error: `Download-Link nur für abgeschlossene Jobs verfügbar (aktuell: ${job.status}).`,
      });
      return;
    }

    if (!job.nzbFile.s3Key) {
      res.status(422).json({ error: "Keine S3-Referenz vorhanden." });
      return;
    }

    const { isS3Configured, generatePresignedUrl, EXPIRY_PRESETS, MAX_PRESIGNED_EXPIRY_SECONDS } = await import("../lib/s3.js");

    if (!isS3Configured()) {
      res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
      return;
    }

    const rawExpires = req.query.expires;
    if (Array.isArray(rawExpires)) {
      res.status(400).json({ error: "Nur ein expires-Wert erlaubt." });
      return;
    }
    const expiresParam = typeof rawExpires === "string" ? rawExpires : "7d";
    let expiresIn: number;
    if (Object.hasOwn(EXPIRY_PRESETS, expiresParam)) {
      expiresIn = EXPIRY_PRESETS[expiresParam];
    } else if (/^\d+$/.test(expiresParam)) {
      expiresIn = parseInt(expiresParam, 10);
      if (expiresIn < 60) {
        res.status(400).json({ error: "Ungültiger expires-Wert. Verwende 1h, 1d, 3d, 7d oder Sekunden (min 60)." });
        return;
      }
    } else {
      res.status(400).json({ error: "Ungültiger expires-Wert. Verwende 1h, 1d, 3d, 7d oder Sekunden (min 60)." });
      return;
    }

    const cappedExpires = Math.min(expiresIn, MAX_PRESIGNED_EXPIRY_SECONDS);
    const url = await generatePresignedUrl(job.nzbFile.s3Key, cappedExpires);
    const expiresAt = new Date(Date.now() + cappedExpires * 1000).toISOString();

    console.log(`[download-job] Link generated: job ${job.id} → ${job.nzbFile.hash.slice(0, 12)}... (expires: ${expiresParam})`);

    res.json({
      url,
      expiresIn: cappedExpires,
      expiresAt,
      job: { id: job.id, status: job.status },
      nzbFile: {
        id: job.nzbFile.id,
        hash: job.nzbFile.hash,
        s3Key: job.nzbFile.s3Key,
        resolution: job.nzbFile.resolution,
      },
      movie: job.nzbFile.movie,
    });
  } catch (err) {
    console.error("[download-job] Link error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Download-Links." });
  }
});

// POST /downloads/jobs/:id/provision — create a VPS for a download job
router.post("/jobs/:id/provision", async (req: AuthRequest, res: Response) => {
  try {
    if (!isHetznerConfigured()) {
      res.status(503).json({ error: "Hetzner Cloud API ist nicht konfiguriert." });
      return;
    }

    // Validate required config before creating a VPS
    const requiredEnvVars = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "API_BASE_URL", "NZB_SERVICE_URL", "USENET_HOST", "USENET_USER", "USENET_PASSWORD"];
    const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
    if (missingVars.length > 0) {
      res.status(503).json({
        error: `Fehlende Konfiguration: ${missingVars.join(", ")}`,
      });
      return;
    }

    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: { nzbFile: { include: { movie: true } } },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    if (job.status !== "queued") {
      res.status(422).json({
        error: `Job kann nur aus Status 'queued' provisioniert werden (aktuell: ${job.status}).`,
      });
      return;
    }

    // CAS: atomically claim the job so concurrent requests can't both provision
    const casResult = await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "provisioning", startedAt: new Date() },
    });

    if (casResult.count === 0) {
      res.status(409).json({ error: "Job wurde zwischenzeitlich geändert (Konflikt)." });
      return;
    }

    // Generate Cloud-Init script with service token (not user JWT)
    // Build NZB URL pointing to the openmedia-nzb service (not this API)
    const nzbServiceUrl = process.env.NZB_SERVICE_URL;
    if (!nzbServiceUrl) {
      res.status(503).json({ error: "NZB_SERVICE_URL ist nicht konfiguriert." });
      return;
    }

    const cloudInit = generateCloudInit({
      jobId: job.id,
      nzbHash: job.nzbFile.hash,
      nzbUrl: `${nzbServiceUrl}/nzb/${job.nzbFile.hash}.nzb`,
      apiBaseUrl: process.env.API_BASE_URL!,
      apiToken: process.env.SERVICE_API_TOKEN || req.headers.authorization?.replace("Bearer ", "") || "",
      s3AccessKey: process.env.S3_ACCESS_KEY!,
      s3SecretKey: process.env.S3_SECRET_KEY!,
      s3Endpoint: process.env.S3_ENDPOINT!,
      s3Bucket: process.env.S3_BUCKET!,
      s3Region: process.env.S3_REGION || "hel1",
      usenetHost: process.env.USENET_HOST || "",
      usenetPort: parseInt(process.env.USENET_PORT || "563", 10),
      usenetUser: process.env.USENET_USER || "",
      usenetPassword: process.env.USENET_PASSWORD || "",
      usenetSsl: process.env.USENET_SSL !== "false",
      usenetConnections: parseInt(process.env.USENET_CONNECTIONS || "10", 10),
      dockerImage: process.env.DOWNLOADER_DOCKER_IMAGE || "ghcr.io/ichbinder/openmedia-downloader:latest",
      hetznerToken: process.env.HETZNER_API_TOKEN || "",
    });

    const serverName = `dl-${job.id.slice(0, 8)}`;

    let result;
    try {
      result = await createServer({
        name: serverName,
        userData: cloudInit,
        labels: { "job-id": job.id },
      });
    } catch (err: any) {
      // Rollback job status on server creation failure
      await prisma.downloadJob.update({
        where: { id: job.id },
        data: { status: "failed", error: `VPS-Erstellung fehlgeschlagen: ${err.message}`, completedAt: new Date() },
      });
      throw err;
    }

    // Update job with server info
    await prisma.downloadJob.update({
      where: { id: job.id },
      data: {
        hetznerServerId: result.server.id,
        hetznerServerIp: result.server.publicIpv4,
      },
    });

    console.log(`[download-vps] Provisioned: ${serverName} (id: ${result.server.id}) for job ${job.id}`);

    res.status(201).json({
      server: {
        id: result.server.id,
        name: result.server.name,
        status: result.server.status,
        ip: result.server.publicIpv4,
        location: result.server.location,
      },
      job: { id: job.id, status: "provisioning" },
    });
  } catch (err: any) {
    console.error("[download-vps] Provision error:", err.message);
    res.status(500).json({ error: `Fehler beim Erstellen des Download-Servers: ${err.message}` });
  }
});

// POST /downloads/jobs/:id/cleanup — delete VPS for a completed/failed job
router.post("/jobs/:id/cleanup", async (req: AuthRequest, res: Response) => {
  try {
    if (!isHetznerConfigured()) {
      res.status(503).json({ error: "Hetzner Cloud API ist nicht konfiguriert." });
      return;
    }

    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    if (!job.hetznerServerId) {
      res.status(422).json({ error: "Job hat keinen zugeordneten Server." });
      return;
    }

    const deleted = await deleteServer(job.hetznerServerId);

    // Clear server reference from job
    await prisma.downloadJob.update({
      where: { id: job.id },
      data: { hetznerServerId: null, hetznerServerIp: null },
    });

    console.log(`[download-vps] Cleanup: server ${job.hetznerServerId} for job ${job.id} — ${deleted ? "deleted" : "already gone"}`);

    res.json({ success: true, deleted, serverId: job.hetznerServerId });
  } catch (err: any) {
    console.error("[download-vps] Cleanup error:", err.message);
    res.status(500).json({ error: `Fehler beim Löschen des Download-Servers: ${err.message}` });
  }
});

// GET /downloads/servers — list active download servers
router.get("/servers", async (_req: AuthRequest, res: Response) => {
  try {
    if (!isHetznerConfigured()) {
      res.status(503).json({ error: "Hetzner Cloud API ist nicht konfiguriert." });
      return;
    }

    const servers = await listServers("purpose=openmedia-download");

    res.json({
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        ip: s.publicIpv4,
        location: s.location,
        labels: s.labels,
        created: s.created,
      })),
    });
  } catch (err: any) {
    console.error("[download-vps] List servers error:", err.message);
    res.status(500).json({ error: "Fehler beim Laden der Download-Server." });
  }
});

// POST /downloads/cleanup-zombies — find and delete zombie servers
router.post("/cleanup-zombies", async (req: AuthRequest, res: Response) => {
  try {
    if (!isHetznerConfigured()) {
      res.status(503).json({ error: "Hetzner Cloud API ist nicht konfiguriert." });
      return;
    }

    const maxAgeHours = typeof req.body?.maxAgeHours === "number" ? req.body.maxAgeHours : 6;

    if (maxAgeHours < 1 || maxAgeHours > 168) {
      res.status(400).json({ error: "maxAgeHours muss zwischen 1 und 168 (7 Tage) liegen." });
      return;
    }

    const zombies = await findZombieServers(maxAgeHours);

    if (zombies.length === 0) {
      res.json({ cleaned: 0, zombies: [] });
      return;
    }

    // Delete zombies directly (avoid double listServers call)
    const deletedIds: number[] = [];
    for (const server of zombies) {
      try {
        const deleted = await deleteServer(server.id);
        if (deleted) {
          deletedIds.push(server.id);
          console.log(`[download-vps] Zombie cleaned: ${server.name} (id: ${server.id})`);
        }
      } catch (err: any) {
        console.error(`[download-vps] Failed to clean zombie ${server.id}: ${err.message}`);
      }
    }

    res.json({
      cleaned: deletedIds.length,
      deletedServerIds: deletedIds,
      zombiesFound: zombies.length,
    });
  } catch (err: any) {
    console.error("[download-vps] Cleanup zombies error:", err.message);
    res.status(500).json({ error: "Fehler beim Bereinigen verwaister Server." });
  }
});

export default router;
