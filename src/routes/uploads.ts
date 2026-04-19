import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, requireServiceOrUserAuth, type AuthRequest } from "../middleware/auth.js";
import { isHetznerConfigured, provisionUploadVps, deleteServer } from "../lib/hetzner.js";
import { getUploadVpsConfig } from "../lib/vps-config.js";
import { generateServiceToken, storeServiceToken, deleteServiceTokens } from "../lib/service-token.js";
import { resolveQualityTier } from "../lib/nzb-parser.js";

const router = Router();

// Allow both JWT (web UI) and service tokens (VPS callbacks) on all upload routes.
// Upload VPS calls PATCH /:id with service tokens to report status.
router.use(requireServiceOrUserAuth);

/** Safely coerce a value to integer, returning null on invalid input. */
function safeInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * Safely coerce a value to boolean | null.
 * Returns null for unparseable values so existing metadata is NOT overwritten
 * with a wrong false. Only canonical boolean representations are accepted.
 */
function safeBoolValue(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === "string") {
    const low = v.toLowerCase();
    if (low === "true" || low === "1") return true;
    if (low === "false" || low === "0") return false;
    return null; // unparseable — don't persist as false
  }
  return null;
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
  if (isHetznerConfigured()) {
    const uploadConfig = await getUploadVpsConfig();

    if (!uploadConfig) {
      console.warn("[uploads] Upload config incomplete (neither DB nor ENV sufficient) — skipping VPS provisioning");
    } else {
      try {
        // Generate per-VPS service token (same pattern as download provisioner)
        const { plaintext: serviceToken, hash: tokenHash } = generateServiceToken();
        await storeServiceToken(tokenHash, job.id, "upload");

        const serverName = `up-${nzbFile.hash.substring(0, 8)}`;
        const result = await provisionUploadVps({
          jobId: job.id,
          nzbFileHash: nzbFile.hash,
          apiBaseUrl: uploadConfig.apiBaseUrl,
          serviceToken,
          dockerImage: uploadConfig.source === "db"
            ? undefined  // use default image
            : process.env.UPLOADER_DOCKER_IMAGE,
          serverName,
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
      } catch (err) {
        // Orphan token cleanup on Hetzner createServer failure
        deleteServiceTokens(job.id).catch(() => {});
        console.error(`[uploads] VPS provisioning failed: ${(err as Error).message}`);
        // Job stays as 'queued' — user can retry manually or reconciler picks it up
      }
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

  // If completed: wrap the status update, metadata persistence, and new NzbFile
  // creation in a single transaction so failures don't leave the job in an
  // inconsistent "completed" state with half-written metadata.
  // If not completed, just update the job normally.
  let updated: Awaited<ReturnType<typeof prisma.uploadJob.update>> | undefined;

  if (status === "completed") {
    const meta = metadata && typeof metadata === "object" ? metadata : {};
    const hasMetadata = Object.keys(meta).length > 0;
    updated = await prisma.$transaction(async (tx) => {
      // 1. Update job status
      const jobUpdated = await tx.uploadJob.update({ where: { id }, data: updateData });

      // Check for existing NzbFile inside the transaction to prevent race conditions
      const existingNzb = nzbHash
        ? await tx.nzbFile.findUnique({ where: { hash: nzbHash }, select: { id: true } })
        : null;

      // 2. Update original NzbFile with ffprobe metadata (only valid, non-null values)
      if (hasMetadata) {
        const metaUpdate: Record<string, unknown> = {};
        if (meta.qualityTier || meta.resolution) metaUpdate.qualityTier = resolveQualityTier(String(meta.qualityTier || meta.resolution || ""));
        if (typeof meta.resolution === "string") metaUpdate.resolution = meta.resolution;
        if (typeof meta.codec === "string") metaUpdate.codec = meta.codec;
        const nw = safeInt(meta.videoWidth); if (nw != null) metaUpdate.videoWidth = nw;
        const nh = safeInt(meta.videoHeight); if (nh != null) metaUpdate.videoHeight = nh;
        const nb = safeInt(meta.videoBitrate); if (nb != null) metaUpdate.videoBitrate = nb;
        if (typeof meta.videoFramerate === "string") metaUpdate.videoFramerate = meta.videoFramerate;
        const nd = safeInt(meta.videoColorDepth); if (nd != null) metaUpdate.videoColorDepth = nd;
        const hb = safeBoolValue(meta.hdr); if (hb != null) metaUpdate.hdr = hb;
        if (typeof meta.hdrFormat === "string") metaUpdate.hdrFormat = meta.hdrFormat;
        if (typeof meta.audioCodec === "string") metaUpdate.audioCodec = meta.audioCodec;
        if (typeof meta.audioChannels === "string") metaUpdate.audioChannels = meta.audioChannels;
        const ab = safeInt(meta.audioBitrate); if (ab != null) metaUpdate.audioBitrate = ab;
        if (Array.isArray(meta.audioLanguages)) metaUpdate.audioLanguages = meta.audioLanguages;
        if (Array.isArray(meta.subtitleLanguages)) metaUpdate.subtitleLanguages = meta.subtitleLanguages;
        const dur = safeInt(meta.duration); if (dur != null) metaUpdate.duration = dur;
        const fs = safeBigInt(meta.fileSize); if (fs != null) metaUpdate.fileSize = fs;
        if (meta.mediaInfo && typeof meta.mediaInfo === "object") metaUpdate.mediaInfo = meta.mediaInfo;

        if (Object.keys(metaUpdate).length > 0) {
          await tx.nzbFile.update({ where: { id: job.nzbFileId }, data: metaUpdate });
          console.log(`[uploads] Updated original NzbFile ${job.nzbFileId} with ffprobe metadata [${meta.qualityTier || "?"} ${meta.codec || "?"}]`);
        }
      }

      // 3. Create new NzbFile (source='own') if nzbHash provided
      if (nzbHash && !existingNzb) {
        const originalFile = await tx.nzbFile.findUnique({
          where: { id: job.nzbFileId },
          select: { hash: true, originalFilename: true, movieId: true },
        });

        const targetMovieId = originalFile?.movieId ?? null;

        await tx.nzbFile.create({
          data: {
            hash: nzbHash,
            originalFilename: `${originalFile?.originalFilename || "unknown"}.own.nzb`,
            source: "own",
            status: "untested",
            movieId: targetMovieId,
            qualityTier: resolveQualityTier(String(meta.qualityTier || meta.resolution || "") || null),
            resolution: typeof meta.resolution === "string" ? meta.resolution : null,
            codec: typeof meta.codec === "string" ? meta.codec : null,
            videoWidth: safeInt(meta.videoWidth),
            videoHeight: safeInt(meta.videoHeight),
            videoBitrate: safeInt(meta.videoBitrate),
            videoFramerate: typeof meta.videoFramerate === "string" ? meta.videoFramerate : null,
            videoColorDepth: safeInt(meta.videoColorDepth),
            hdr: meta.hdr != null ? safeBoolValue(meta.hdr) : null,
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
      } else if (nzbHash && existingNzb) {
        console.log(`[uploads] NzbFile with hash ${nzbHash} already exists — skipping create`);
      }

      return jobUpdated;
    });
  } else {
    updated = await prisma.uploadJob.update({
      where: { id },
      data: updateData,
    });
  }

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

    // Delete service tokens for this job (non-fatal)
    try {
      await deleteServiceTokens(id);
    } catch (tokenErr: any) {
      console.error(`[uploads] Token cleanup failed (non-fatal): ${tokenErr.message}`);
    }
  }

  console.log(`[uploads] UploadJob ${id} → ${status || job.status}`);
  res.json({
    id: updated.id,
    status: updated.status,
    completedAt: updated!.completedAt,
  });
});

export default router;
