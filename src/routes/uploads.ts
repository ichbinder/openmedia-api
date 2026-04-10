import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { isHetznerConfigured, provisionUploadVps } from "../lib/hetzner.js";

const router = Router();

router.use(requireAuth);

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

  // Verify NzbFile exists and doesn't already have our own upload
  const nzbFile = await prisma.nzbFile.findUnique({
    where: { id: nzbFileId },
    include: { uploadJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (!nzbFile) {
    res.status(404).json({ error: "NzbFile not found" });
    return;
  }

  if (nzbFile.ownUsenetHash) {
    res.status(409).json({
      error: "NzbFile already has an own Usenet upload",
      ownUsenetHash: nzbFile.ownUsenetHash,
    });
    return;
  }

  // Check if there's already a running/pending upload job
  const existingJob = nzbFile.uploadJobs[0];
  if (existingJob && (existingJob.status === "queued" || existingJob.status === "running")) {
    res.status(409).json({
      error: "Upload job already in progress",
      jobId: existingJob.id,
      status: existingJob.status,
    });
    return;
  }

  if (!nzbFile.s3Key) {
    res.status(400).json({ error: "NzbFile has no s3Key — no file to upload" });
    return;
  }

  // Create the upload job
  const job = await prisma.uploadJob.create({
    data: {
      nzbFileId: nzbFile.id,
      status: "queued",
    },
  });

  console.log(`[uploads] Created UploadJob ${job.id} for NzbFile ${nzbFile.id} (hash=${nzbFile.hash})`);

  // Start upload VPS if Hetzner is configured
  if (isHetznerConfigured()) {
    try {
      const providerEnvPrefixes = ["USENET_PROVIDER_1_", "USENET_PROVIDER_2_", "USENET_PROVIDER_3_"];
      const usenetProviders = providerEnvPrefixes
        .map((prefix, i) => {
          const host = process.env[`${prefix}HOST`];
          const user = process.env[`${prefix}USER`];
          if (!host || !user) return null;
          return {
            host,
            port: Number(process.env[`${prefix}PORT`] || "563"),
            username: user,
            password: process.env[`${prefix}PASS`] || "",
            ssl: process.env[`${prefix}SSL`] !== "0",
            connections: Number(process.env[`${prefix}CONNS`] || "10"),
          };
        })
        .filter(Boolean) as Array<{
          host: string;
          port: number;
          username: string;
          password: string;
          ssl: boolean;
          connections: number;
        }>;

      if (usenetProviders.length < 3) {
        console.warn(
          `[uploads] Only ${usenetProviders.length}/3 usenet providers configured — upload may fail`
        );
      }

      const result = await provisionUploadVps({
        uploadJobId: job.id,
        nzbFileHash: nzbFile.hash,
        s3Key: nzbFile.s3Key!,
        apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4000",
        apiToken: process.env.SERVICE_TOKEN || "",
        hetznerApiToken: process.env.HETZNER_API_TOKEN || "",
        s3AccessKey: process.env.S3_ACCESS_KEY || "",
        s3SecretKey: process.env.S3_SECRET_KEY || "",
        s3Endpoint: process.env.S3_ENDPOINT || "",
        s3Bucket: process.env.S3_BUCKET || "",
        usenetProviders,
      });

      // Update job with VPS info
      await prisma.uploadJob.update({
        where: { id: job.id },
        data: {
          status: "running",
          hetznerServerId: result.server.id,
          hetznerServerIp: result.server.publicIpv4,
          startedAt: new Date(),
        },
      });

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
  const { status, error, nzbS3Key, hetznerServerId, hetznerServerIp } = req.body;

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
  if (nzbS3Key) updateData.nzbS3Key = nzbS3Key;
  if (hetznerServerId) updateData.hetznerServerId = hetznerServerId;
  if (hetznerServerIp) updateData.hetznerServerIp = hetznerServerIp;
  if (status === "running" && !job.startedAt) updateData.startedAt = new Date();
  if (status === "completed" || status === "failed") {
    updateData.completedAt = new Date();
  }

  const updated = await prisma.uploadJob.update({
    where: { id },
    data: updateData,
  });

  // If completed with nzbS3Key, set ownUsenetHash on NzbFile
  if (status === "completed" && nzbS3Key) {
    const uploadHash = job.nzbFileId; // Use nzbFile hash as the unique identifier
    await prisma.nzbFile.update({
      where: { id: job.nzbFileId },
      data: {
        ownUsenetHash: uploadHash,
        ownNzbS3Key: nzbS3Key,
        ownUsenetUploadedAt: new Date(),
      },
    });
    console.log(
      `[uploads] UploadJob ${id} completed — NzbFile ${job.nzbFileId} ownUsenetHash set`
    );
  }

  console.log(`[uploads] UploadJob ${id} → ${status || job.status}`);
  res.json({
    id: updated.id,
    status: updated.status,
    nzbS3Key: updated.nzbS3Key,
    completedAt: updated.completedAt,
  });
});

export default router;
