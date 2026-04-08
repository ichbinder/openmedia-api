/**
 * Test-only HTTP routes used by the E2E test suite (see openmedia-web
 * Playwright specs). The entire router group is gated behind
 * `NODE_ENV === "test"` — in any other environment every request in this
 * router returns 404, making the endpoints effectively invisible in
 * production.
 *
 * The router is mounted conditionally in `app.ts`, so in a non-test build
 * the route paths are never even registered. The in-router guard below is a
 * defense-in-depth layer in case someone mounts it unconditionally in the
 * future.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import prisma from "../lib/prisma.js";

const router = Router();

/**
 * Defense-in-depth guard: every request routed through this router must
 * pass the NODE_ENV check. If NODE_ENV is not "test" we respond with the
 * same 404 body Express would produce for an unmounted route, so the
 * presence of the router is not observable from the outside.
 */
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== "test") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

/**
 * Force-complete a download job — simulates the success callback that the
 * download container normally posts back after a successful download + S3
 * upload cycle.
 *
 * Behavior matches the real `POST /downloads/jobs/:id/callback` "completed"
 * branch as closely as possible:
 *   1. Flip the DownloadJob to status="completed" with progress=100.
 *   2. Populate the related NzbFile with fake S3 keys so the UI thinks the
 *      movie is ready to stream.
 *   3. Upsert a UserLibrary row so the job's owner sees the movie in their
 *      library, matching the production auto-add behavior.
 *
 * All three writes are wrapped in a transaction so a partial failure leaves
 * the DB in a consistent state.
 */
router.post("/jobs/:id/force-complete", async (req: Request, res: Response) => {
  const jobId = String(req.params.id);

  const job = await prisma.downloadJob.findUnique({
    where: { id: jobId },
    include: { nzbFile: true },
  });

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (!job.userId) {
    res.status(400).json({ error: "Job has no userId — cannot upsert library entry" });
    return;
  }

  const userId = job.userId;
  const nzbFileId = job.nzbFileId;
  const hash = job.nzbFile.hash;
  const fakeS3Key = `${hash}/${hash}.mkv`;
  const fakeStreamKey = `${hash}/${hash}_stream.mp4`;
  const now = new Date();

  await prisma.$transaction([
    prisma.downloadJob.update({
      where: { id: jobId },
      data: {
        status: "completed",
        progress: 100,
        completedAt: now,
        error: null,
      },
    }),
    prisma.nzbFile.update({
      where: { id: nzbFileId },
      data: {
        s3Key: fakeS3Key,
        s3StreamKey: fakeStreamKey,
        s3Bucket: "e2e-fake-bucket",
        fileExtension: "mkv",
        downloadedAt: now,
        lastAccessedAt: now,
      },
    }),
    prisma.userLibrary.upsert({
      where: {
        userId_nzbFileId: {
          userId,
          nzbFileId,
        },
      },
      create: {
        userId,
        nzbFileId,
      },
      update: {
        removedAt: null,
      },
    }),
  ]);

  console.log(
    `[test:force-complete] Job ${jobId} marked completed, NzbFile ${nzbFileId} got fake s3 keys`,
  );

  res.json({
    ok: true,
    jobId,
    nzbFileId,
    s3Key: fakeS3Key,
    s3StreamKey: fakeStreamKey,
  });
});

export default router;
