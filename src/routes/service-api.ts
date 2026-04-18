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
    // Static ENV tokens (no req.serviceToken) can access any job (backward compat).
    if (req.serviceToken && req.serviceToken.jobId !== requestedJobId) {
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

      console.log(`[service-api] Bootstrap served for download job ${requestedJobId}`);
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

    console.log(`[service-api] Bootstrap served for upload job ${requestedJobId}`);
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
    });
  } catch (err) {
    console.error("[service-api] Bootstrap error:", err);
    res.status(500).json({ error: "Bootstrap failed." });
  }
});

export default router;
