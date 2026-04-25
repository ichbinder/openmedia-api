/**
 * Service API Routes — VPS-callable endpoints behind service token auth.
 *
 * These endpoints are called by VPS instances (downloader/uploader containers)
 * to fetch their job details and infrastructure config at boot time.
 */

import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireServiceToken, type AuthRequest } from "../middleware/auth.js";
import { getDownloadVpsConfig, getUploadVpsConfig } from "../lib/vps-config.js";

const router = Router();

router.use(requireServiceToken);

/**
 * GET /service/jobs/:id/bootstrap
 *
 * Returns job details + infra config for a VPS instance.
 * Validates that the service token's jobId matches the requested job (scoped access).
 */
router.get("/jobs/:id/bootstrap", async (req: AuthRequest, res: Response) => {
  try {
    const requestedJobId = String(req.params.id);

    // Scoped access: DB-issued tokens can only access their own job.
    if (!req.serviceToken) {
      // Legacy static token — reject unless migration flag is set
      if (process.env.ENABLE_LEGACY_SERVICE_TOKEN === "true") {
        console.warn(`[service-api] Legacy static token used for job ${requestedJobId} — migrate to per-job tokens`);
      } else {
        console.log(`[service-api] Static token rejected — per-job token required for bootstrap`);
        res.status(401).json({ error: "Per-job service token required." });
        return;
      }
    } else if (req.serviceToken.jobId !== requestedJobId) {
      console.log(
        `[service-api] Token scoped to job ${req.serviceToken.jobId} tried to access job ${requestedJobId}`,
      );
      res.status(401).json({ error: "Token not authorized for this job." });
      return;
    }

    // Look up the download job first
    const downloadJob = await prisma.downloadJob.findUnique({
      where: { id: requestedJobId },
    });

    if (downloadJob) {
      // ── Download job bootstrap ──
      const nzbFile = await prisma.nzbFile.findUnique({
        where: { id: downloadJob.nzbFileId },
        select: { id: true, hash: true, originalFilename: true },
      });

      if (!nzbFile) {
        res.status(404).json({ error: "NZB file not found." });
        return;
      }

      const config = await getDownloadVpsConfig();
      if (!config) {
        console.error("[service-api] Bootstrap failed: download VPS config unavailable");
        res.status(503).json({ error: "Infrastructure config unavailable." });
        return;
      }

      console.log(`[service-api] Bootstrap served for download job ${requestedJobId} (vpn: ${config.vpnConfig ? "yes" : "no"})`);
      res.json({
        job: {
          id: downloadJob.id,
          hash: nzbFile.hash,
          nzbFileId: nzbFile.id,
          originalFilename: nzbFile.originalFilename,
          status: downloadJob.status,
        },
        config: {
          apiBaseUrl: config.apiBaseUrl,
          s3AccessKey: config.s3AccessKey,
          s3SecretKey: config.s3SecretKey,
          s3Endpoint: config.s3Endpoint,
          s3Bucket: config.s3Bucket,
          s3Region: config.s3Region,
          nzbServiceUrl: config.nzbServiceUrl,
          usenetServers: config.usenetServers,
        },
        vpnConfig: config.vpnConfig ?? undefined,
        routingPolicy: config.routingPolicy ?? undefined,
      });
      return;
    }

    // ── Upload job bootstrap (fallback) ──
    const uploadJob = await prisma.uploadJob.findUnique({
      where: { id: requestedJobId },
    });

    if (!uploadJob) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    const nzbFile = await prisma.nzbFile.findUnique({
      where: { id: uploadJob.nzbFileId },
      select: { id: true, hash: true, s3Key: true },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "NZB file not found." });
      return;
    }

    const uploadConfig = await getUploadVpsConfig();
    if (!uploadConfig) {
      console.error("[service-api] Bootstrap failed: upload VPS config unavailable");
      res.status(503).json({ error: "Infrastructure config unavailable." });
      return;
    }

    console.log(`[service-api] Bootstrap served for upload job ${requestedJobId} (vpn: ${uploadConfig.vpnConfig ? "yes" : "no"})`);
    res.json({
      job: {
        id: uploadJob.id,
        hash: nzbFile.hash,
        nzbFileId: nzbFile.id,
        s3Key: nzbFile.s3Key,
        movieId: uploadJob.movieId,
        status: uploadJob.status,
      },
      config: {
        s3AccessKey: uploadConfig.s3AccessKey,
        s3SecretKey: uploadConfig.s3SecretKey,
        s3Endpoint: uploadConfig.s3Endpoint,
        s3Bucket: uploadConfig.s3Bucket,
        nzbServiceUrl: uploadConfig.nzbServiceUrl,
        nzbServiceToken: uploadConfig.nzbServiceToken,
        usenetProviders: uploadConfig.usenetProviders,
      },
      vpnConfig: uploadConfig.vpnConfig ?? undefined,
      routingPolicy: uploadConfig.routingPolicy ?? undefined,
    });
  } catch (err) {
    console.error("[service-api] Bootstrap error:", err);
    res.status(500).json({ error: "Bootstrap failed." });
  }
});

// ─── VPS Event Reporting ─────────────────────────────────────────────

const VALID_EVENT_TYPES = ["routing_anomaly", "vpn_down", "vpn_reconnect", "watchdog", "bootstrap"] as const;
const VALID_SEVERITIES = ["info", "warning", "critical"] as const;

/**
 * POST /service/jobs/:id/events
 *
 * Reports a VPS runtime event (routing anomaly, watchdog status, etc.).
 * The VPS calls this to log events that are persisted in the VpsEvent table.
 */
router.post("/jobs/:id/events", async (req: AuthRequest, res: Response) => {
  try {
    const requestedJobId = String(req.params.id);

    // Scoped access: legacy static tokens are never allowed for event reporting.
    // A legacy token has no jobId and cannot be scoped to a specific job,
    // so it would silently have write access to any job's events — reject it.
    if (!req.serviceToken) {
      console.log(`[vps-event] Legacy static token rejected for event POST on job ${requestedJobId} — per-job token required`);
      res.status(401).json({ error: "Per-job service token required for event reporting." });
      return;
    }
    if (req.serviceToken.jobId !== requestedJobId) {
      console.log(
        `[vps-event] Token scoped to job ${req.serviceToken.jobId} tried to post event for job ${requestedJobId}`,
      );
      res.status(401).json({ error: "Token not authorized for this job." });
      return;
    }

    const { eventType, severity, details } = req.body;

    // Validate details payload size (max 64 KB serialized)
    if (details) {
      const serialized = JSON.stringify(details);
      if (serialized.length > 65_536) {
        res.status(400).json({
          error: "details payload too large (max 64 KB)",
        });
        return;
      }
    }

    // Validate eventType
    if (!eventType || !VALID_EVENT_TYPES.includes(eventType)) {
      res.status(400).json({
        error: `Invalid eventType. Must be one of: ${VALID_EVENT_TYPES.join(", ")}`,
      });
      return;
    }

    // Validate severity (optional, defaults to 'warning')
    const sev = severity || "warning";
    if (!VALID_SEVERITIES.includes(sev)) {
      res.status(400).json({
        error: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(", ")}`,
      });
      return;
    }

    // Determine job type by looking up both tables
    let jobType: string | null = null;
    const downloadJob = await prisma.downloadJob.findUnique({
      where: { id: requestedJobId },
      select: { id: true },
    });
    if (downloadJob) {
      jobType = "download";
    } else {
      const uploadJob = await prisma.uploadJob.findUnique({
        where: { id: requestedJobId },
        select: { id: true },
      });
      if (uploadJob) {
        jobType = "upload";
      }
    }

    if (!jobType) {
      res.status(404).json({ error: "Job not found." });
      return;
    }

    const event = await prisma.vpsEvent.create({
      data: {
        ...(jobType === "download"
          ? { downloadJobId: requestedJobId }
          : { uploadJobId: requestedJobId }),
        jobType,
        eventType,
        severity: sev,
        details: details || {},
      },
    });

    if (sev === "critical") {
      console.error(`[vps-event] CRITICAL ${eventType} for ${jobType} job ${requestedJobId}`);
    } else {
      console.log(`[vps-event] ${sev} ${eventType} for ${jobType} job ${requestedJobId}`);
    }

    res.status(201).json({ id: event.id });
  } catch (err) {
    console.error("[vps-event] Error:", err);
    res.status(500).json({ error: "Failed to record event." });
  }
});

/**
 * GET /service/jobs/:id/events
 *
 * Returns VPS events for a job. Supports ?limit=N (default 50) and ?eventType=... filter.
 */
router.get("/jobs/:id/events", async (req: AuthRequest, res: Response) => {
  try {
    const requestedJobId = String(req.params.id);

    // Scoped access: legacy static tokens are never allowed for event reads.
    // Without a jobId in the token there is no way to scope access to a single job.
    if (!req.serviceToken) {
      console.log(`[vps-event] Legacy static token rejected for event GET on job ${requestedJobId} — per-job token required`);
      res.status(401).json({ error: "Per-job service token required for event access." });
      return;
    }
    if (req.serviceToken.jobId !== requestedJobId) {
      console.log(
        `[vps-event] Token scoped to job ${req.serviceToken.jobId} tried to read events for job ${requestedJobId}`,
      );
      res.status(401).json({ error: "Token not authorized for this job." });
      return;
    }

    const parsed = parseInt(String(req.query.limit || "50"), 10);
    if (!Number.isNaN(parsed) && parsed <= 0) {
      res.status(400).json({ error: "limit must be greater than 0." });
      return;
    }
    const limit = Number.isNaN(parsed) ? 50 : Math.min(parsed, 200);
    const eventTypeFilter = req.query.eventType ? String(req.query.eventType) : undefined;

    const events = await prisma.vpsEvent.findMany({
      where: {
        OR: [
          { downloadJobId: requestedJobId },
          { uploadJobId: requestedJobId },
        ],
        ...(eventTypeFilter ? { eventType: eventTypeFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.json({ events });
  } catch (err) {
    console.error("[vps-event] Error:", err);
    res.status(500).json({ error: "Failed to fetch events." });
  }
});

export default router;
