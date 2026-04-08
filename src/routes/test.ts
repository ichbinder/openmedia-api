/**
 * Test-only HTTP routes used by the E2E test suite (see openmedia-web
 * Playwright specs). The entire router group is triple-gated:
 *
 *   1. Mount-time: `app.ts` only calls `app.use("/test", ...)` when
 *      `NODE_ENV === "test"`. In a normal dev/prod build the routes are
 *      not even registered in the Express request pipeline.
 *
 *   2. Runtime: the middleware below rejects any request when
 *      `NODE_ENV !== "test"` with a plain 404. This is defense-in-depth
 *      in case someone refactors app.ts and accidentally mounts the
 *      router unconditionally.
 *
 *   3. Opt-in flag: the same middleware requires an explicit
 *      `ENABLE_TEST_ENDPOINTS="1"` environment variable. Turning the
 *      test endpoints on in a production-ish environment requires two
 *      independent env vars to be flipped in the wrong direction at the
 *      same time — a deliberate opt-in rather than a single mistake.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import prisma from "../lib/prisma.js";

const router = Router();

/**
 * Defense-in-depth guard: every request routed through this router must
 * pass BOTH checks. When either check fails we respond with the same 404
 * body Express would produce for an unmounted route, so the presence of
 * the router is not observable from the outside.
 */
router.use((_req: Request, res: Response, next: NextFunction) => {
  const isTestEnv = process.env.NODE_ENV === "test";
  const isExplicitlyEnabled = process.env.ENABLE_TEST_ENDPOINTS === "1";
  if (!isTestEnv || !isExplicitlyEnabled) {
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
  const previousStatus = job.status;
  const fakeS3Key = `${hash}/${hash}.mkv`;
  const fakeStreamKey = `${hash}/${hash}_stream.mp4`;
  const now = new Date();

  // Compare-and-swap transaction: matches the production callback pattern in
  // downloads.ts so a concurrent reconciler (e.g. needs_review → expired)
  // can't be silently overwritten. If the job's status has changed between
  // the read and the write the whole force-complete is aborted with 409.
  const casResult = await prisma.$transaction(async (tx) => {
    const cas = await tx.downloadJob.updateMany({
      where: { id: jobId, status: previousStatus },
      data: {
        status: "completed",
        progress: 100,
        completedAt: now,
        error: null,
      },
    });

    if (cas.count === 0) {
      return { conflict: true as const };
    }

    await tx.nzbFile.update({
      where: { id: nzbFileId },
      data: {
        s3Key: fakeS3Key,
        s3StreamKey: fakeStreamKey,
        s3Bucket: "e2e-fake-bucket",
        // Match the production schema contract: fileExtension must start
        // with a dot (validated in downloads.ts callback handler).
        fileExtension: ".mkv",
        downloadedAt: now,
        lastAccessedAt: now,
      },
    });

    await tx.userLibrary.upsert({
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
        // Match production behavior in downloads.ts / library.ts: a re-add
        // clears removedAt AND bumps addedAt so the film jumps to the top
        // of the user's library list.
        removedAt: null,
        addedAt: now,
      },
    });

    return { conflict: false as const };
  });

  if (casResult.conflict) {
    res.status(409).json({
      error: `Status wurde zwischenzeitlich geändert (erwartet: ${previousStatus})`,
    });
    return;
  }

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
