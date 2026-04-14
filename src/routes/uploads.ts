import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { isHetznerConfigured, provisionUploadVps, deleteServer } from "../lib/hetzner.js";
import { parseUploadProvidersFromEnv } from "../lib/usenet-config.js";
import { resolveQualityTier } from "../lib/nzb-parser.js";

const router = Router();

router.use(requireAuth);

/** Safely coerce a value to integer, returning null on invalid input. */
function safeInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Safely coerce a value to boolean, handling string "false"/"0" correctly. */
function safeBool(v: unknown): boolean {
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return Boolean(v);
}

/** Safely coerce a value to BigInt, returning null on invalid input. */
function safeBigInt(v: unknown): bigint | null {
  if (v == null) return null;
  try { return BigInt(v as string | number); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Valid statuses for upload jobs
// ---------------------------------------------------------------------------
const VALID_STATUSES = ["queued", "running", "completed", "failed"] as const;
type UploadJobStatus = (typeof VALID_STATUSES)[number];

const STATUS_TRANSITIONS: Record<string, UploadJobStatus[]> = {
  queued: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// POST / — create an upload job for an NzbFile
// ---------------------------------------------------------------------------
router.post("/", async (req: AuthRequest, res: Response) => {
  const { nzbFileId } = req.body;

  if (!nzbFileId) {
    res.status(400).json({ error: "nzbFileId is required" });
    return;
  }

  // Verify NzbFile exists
  const nzbFile = await prisma.nzbFile.findUnique({
    where: { id: nzbFileId },
    select: { id: true, hash: true, s3Key: true, source: true },
  });

  if (!nzbFile) {
    res.status(404).json({ error: "NzbFile not found" });
    return;
  }

  if (!nzbFile.s3Key) {
    res.status(400).json({ error: "NzbFile has no s3Key — no file to upload" });
    return;
  }

  // Atomically create upload job (prevents races from parallel requests)
  let job;
  try {
    job = await prisma.$transaction(async (tx) => {
      const nzb = await tx.nzbFile.findUnique({
        where: { id: nzbFileId },
        select: { source: true },
      });
      if (nzb?.source === "own") throw new Error("ALREADY_UPLOADED");

      const existing = await tx.uploadJob.findFirst({
        where: { nzbFileId, status: { in: ["queued", "running"] } },
      });
      if (existing) throw new Error("ALREADY_IN_PROGRESS");

      return tx.uploadJob.create({
        data: { nzbFileId, status: "queued" },
      });
    });
  } catch (txErr) {
    const msg = (txErr as Error).message;
    if (msg === "ALREADY_UPLOADED") {
      res.status(409).json({
        error: "NzbFile is source='own' — already self-created",
      });
      return;
    }
    if (msg === "ALREADY_IN_PROGRESS") {
      res.status(409).json({ error: "Upload job already in progress" });
      return;
    }
    throw txErr;
  }

  console.log(`[uploads] Created UploadJob ${job.id} for NzbFile ${nzbFile.id} (hash=${nzbFile.hash})`);

  // Start upload VPS if fully configured
  const requiredEnv = ["SERVICE_API_TOKEN", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "NZB_SERVICE_URL", "NZB_SERVICE_TOKEN"];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);

  if (isHetznerConfigured() && missingEnv.length === 0) {
    try {
      const usenetProviders = parseUploadProvidersFromEnv();

      if (usenetProviders.length === 0) {
        console.warn("[uploads] No usenet providers configured — skipping VPS provisioning");
      } else {
        const result = await provisionUploadVps({
          uploadJobId: job.id,
          nzbFileHash: nzbFile.hash,
          s3Key: nzbFile.s3Key!,
          apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4000",
          apiToken: process.env.SERVICE_API_TOKEN || "",
          s3AccessKey: process.env.S3_ACCESS_KEY || "",
          s3SecretKey: process.env.S3_SECRET_KEY || "",
          s3Endpoint: process.env.S3_ENDPOINT || "",
          s3Bucket: process.env.S3_BUCKET || "",
          nzbServiceUrl: process.env.NZB_SERVICE_URL || "https://nzb.nettoken.de",
          nzbServiceToken: process.env.NZB_SERVICE_TOKEN || "",
          usenetProviders,
        });

        try {
          await prisma.uploadJob.update({
            where: { id: job.id },
            data: {
              status: "running",
              hetznerServerId: result.server.id,
              hetznerServerIp: result.server.publicIpv4,
              startedAt: new Date(),
            },
          });
        } catch (dbErr) {
          console.error(`[uploads] DB update failed after VPS provisioning — deleting orphan server ${result.server.id}: ${(dbErr as Error).message}`);
          deleteServer(result.server.id).catch(() => {});
          throw dbErr;
        }

        console.log(
          `[uploads] Upload VPS provisioned: ${result.server.name} (id=${result.server.id}, ip=${result.server.publicIpv4})`
        );

        res.status(201).json({
          id: job.id,
          nzbFileId: job.nzbFileId,
          status: "running",
          hetznerServerId: result.server.id,
          hetznerServerIp: result.server.publicIpv4,
          createdAt: job.createdAt,
        });
        return;
      }
    } catch (err) {
      console.error(`[uploads] VPS provisioning failed: ${(err as Error).message}`);
      // Job stays as 'queued' — user can retry manually or reconciler picks it up
    }
  }

  res.status(201).json({
    id: job.id,
    nzbFileId: job.nzbFileId,
    status: job.status,
    createdAt: job.createdAt,
  });
});

// ---------------------------------------------------------------------------
// GET / — list upload jobs
// ---------------------------------------------------------------------------
router.get("/", async (req: AuthRequest, res: Response) => {
  const status = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
  const limit = Array.isArray(req.query.limit) ? req.query.limit[0] : (req.query.limit || "20");

  const where: Record<string, unknown> = {};
  if (status && typeof status === "string") {
    where.status = status;
  }

  const jobs = await prisma.uploadJob.findMany({
    where,
    include: {
      nzbFile: {
        select: { hash: true, originalFilename: true, s3Key: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(limit) || 20, 100),
  });

  res.json(jobs);
});

// ---------------------------------------------------------------------------
// GET /:id — get single upload job
// ---------------------------------------------------------------------------
router.get("/:id", async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const job = await prisma.uploadJob.findUnique({
    where: { id },
    include: {
      nzbFile: {
        select: { hash: true, originalFilename: true, s3Key: true },
      },
    },
  });

  if (!job) {
    res.status(404).json({ error: "UploadJob not found" });
    return;
  }

  res.json(job);
});

// ---------------------------------------------------------------------------
// PATCH /:id — update upload job status (called by upload VPS)
// ---------------------------------------------------------------------------
router.patch("/:id", async (req: AuthRequest, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { status, error, nzbHash, hetznerServerId, hetznerServerIp, metadata } = req.body;

  const job = await prisma.uploadJob.findUnique({ where: { id } });
  if (!job) {
    res.status(404).json({ error: "UploadJob not found" });
    return;
  }

  // Validate status transition
  if (status) {
    const allowed = STATUS_TRANSITIONS[job.status];
    if (!allowed || !allowed.includes(status)) {
      res.status(409).json({
        error: `Invalid status transition: ${job.status} → ${status}`,
        currentStatus: job.status,
        allowedTransitions: allowed,
      });
      return;
    }
  }

  const updateData: Record<string, unknown> = {};
  if (status) updateData.status = status;
  if (error !== undefined) updateData.error = error;
  if (hetznerServerId) updateData.hetznerServerId = hetznerServerId;
  if (hetznerServerIp) updateData.hetznerServerIp = hetznerServerIp;
  if (nzbHash) updateData.nzbHash = nzbHash;
  if (status === "running" && !job.startedAt) updateData.startedAt = new Date();
  if (status === "completed" || status === "failed") {
    updateData.completedAt = new Date();
  }

  const updated = await prisma.uploadJob.update({
    where: { id },
    data: updateData,
  });

  // If completed or failed: delete the upload VPS server-side
  // (Hetzner token is never exposed to the VPS)
  if ((status === "completed" || status === "failed") && job.hetznerServerId) {
    try {
      const { deleteServer } = await import("../lib/hetzner.js");
      await deleteServer(job.hetznerServerId);
      console.log(`[uploads] VPS ${job.hetznerServerId} deleted after status=${status}`);
    } catch (deleteErr) {
      console.error(`[uploads] Failed to delete VPS ${job.hetznerServerId}:`, deleteErr);
      // Non-blocking — zombie cleanup will catch it later
    }
  }

  // If metadata provided: also update the original NzbFile with ffprobe data.
  // The original NzbFile (external) may only have NZB-parsed resolution/codec.
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const hasMetadata = Object.keys(meta).length > 0;

  if (hasMetadata && status === "completed") {
    const metaUpdate: Record<string, unknown> = {};
    if (meta.qualityTier || meta.resolution) metaUpdate.qualityTier = resolveQualityTier(String(meta.qualityTier || meta.resolution || ""));
    if (typeof meta.resolution === "string") metaUpdate.resolution = meta.resolution;
    if (typeof meta.codec === "string") metaUpdate.codec = meta.codec;
    if (meta.videoWidth != null) metaUpdate.videoWidth = safeInt(meta.videoWidth);
    if (meta.videoHeight != null) metaUpdate.videoHeight = safeInt(meta.videoHeight);
    if (meta.videoBitrate != null) metaUpdate.videoBitrate = safeInt(meta.videoBitrate);
    if (typeof meta.videoFramerate === "string") metaUpdate.videoFramerate = meta.videoFramerate;
    if (meta.videoColorDepth != null) metaUpdate.videoColorDepth = safeInt(meta.videoColorDepth);
    if (meta.hdr != null) metaUpdate.hdr = safeBool(meta.hdr);
    if (typeof meta.hdrFormat === "string") metaUpdate.hdrFormat = meta.hdrFormat;
    if (typeof meta.audioCodec === "string") metaUpdate.audioCodec = meta.audioCodec;
    if (typeof meta.audioChannels === "string") metaUpdate.audioChannels = meta.audioChannels;
    if (meta.audioBitrate != null) metaUpdate.audioBitrate = safeInt(meta.audioBitrate);
    if (Array.isArray(meta.audioLanguages)) metaUpdate.audioLanguages = meta.audioLanguages;
    if (Array.isArray(meta.subtitleLanguages)) metaUpdate.subtitleLanguages = meta.subtitleLanguages;
    if (meta.duration != null) metaUpdate.duration = safeInt(meta.duration);
    if (meta.fileSize != null) metaUpdate.fileSize = safeBigInt(meta.fileSize);
    if (meta.mediaInfo && typeof meta.mediaInfo === "object") metaUpdate.mediaInfo = meta.mediaInfo;

    if (Object.keys(metaUpdate).length > 0) {
      await prisma.nzbFile.update({
        where: { id: job.nzbFileId },
        data: metaUpdate,
      });
      console.log(`[uploads] Updated original NzbFile ${job.nzbFileId} with ffprobe metadata [${meta.qualityTier || "?"} ${meta.codec || "?"}]`);
    }
  }

  // If completed with nzbHash: create a new NzbFile entry (source='own').
  // The new NzbFile represents our self-created NZB in the NZB-Service.
  // It's linked to the same NzbMovie as the original download.
  if (status === "completed" && nzbHash) {
    const existingNzb = await prisma.nzbFile.findUnique({
      where: { hash: nzbHash },
      select: { id: true },
    });

    if (existingNzb) {
      console.log(`[uploads] NzbFile with hash ${nzbHash} already exists — skipping create`);
    } else {
      // Get the original NzbFile for metadata
      const originalFile = await prisma.nzbFile.findUnique({
        where: { id: job.nzbFileId },
        select: { hash: true, originalFilename: true, movieId: true },
      });

      const targetMovieId = originalFile?.movieId ?? null;

      const newNzbFile = await prisma.nzbFile.create({
        data: {
          hash: nzbHash,
          originalFilename: `${originalFile?.originalFilename || "unknown"}.own.nzb`,
          source: "own",
          status: "untested",
          movieId: targetMovieId,
          // Media metadata from ffprobe (if provided) — safe coercion to prevent 500s
          qualityTier: resolveQualityTier(String(meta.qualityTier || meta.resolution || "") || null),
          resolution: typeof meta.resolution === "string" ? meta.resolution : null,
          codec: typeof meta.codec === "string" ? meta.codec : null,
          videoWidth: safeInt(meta.videoWidth),
          videoHeight: safeInt(meta.videoHeight),
          videoBitrate: safeInt(meta.videoBitrate),
          videoFramerate: typeof meta.videoFramerate === "string" ? meta.videoFramerate : null,
          videoColorDepth: safeInt(meta.videoColorDepth),
          hdr: meta.hdr != null ? safeBool(meta.hdr) : null,
          hdrFormat: typeof meta.hdrFormat === "string" ? meta.hdrFormat : null,
          audioCodec: typeof meta.audioCodec === "string" ? meta.audioCodec : null,
          audioChannels: typeof meta.audioChannels === "string" ? meta.audioChannels : null,
          audioBitrate: safeInt(meta.audioBitrate),
          audioLanguages: Array.isArray(meta.audioLanguages) ? meta.audioLanguages : [],
          subtitleLanguages: Array.isArray(meta.subtitleLanguages) ? meta.subtitleLanguages : [],
          duration: safeInt(meta.duration),
          fileSize: safeBigInt(meta.fileSize),
          mediaInfo: meta.mediaInfo && typeof meta.mediaInfo === "object" ? meta.mediaInfo : undefined,
        },
      });

      console.log(
        `[uploads] Created NzbFile ${nzbHash} (source=own) for Movie ${targetMovieId || "none"}` +
        (meta.qualityTier ? ` [${meta.qualityTier} ${meta.codec || "?"}]` : "")
      );
    }
  }

  console.log(`[uploads] UploadJob ${id} → ${status || job.status}`);
  res.json({
    id: updated.id,
    status: updated.status,
    completedAt: updated.completedAt,
  });
});

export default router;
