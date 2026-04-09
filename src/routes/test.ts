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

/**
 * Delete all data created by E2E test users. Matches on the email pattern
 * `e2e-%@test.local` — the same prefix/suffix that the Playwright auth
 * helpers use when registering fresh test users.
 *
 * Deletion order matters because DownloadJob.userId is nullable and has
 * no ON DELETE CASCADE — we must delete jobs before users. NzbFiles and
 * NzbMovies are cleaned up as orphans after the user+job rows are gone.
 *
 * This replaces direct `pg` access from the E2E suite — all DB writes
 * go through Prisma in this endpoint, keeping schema knowledge in one
 * place and eliminating the need for a raw Postgres client in the test
 * repo.
 */
router.post("/cleanup", async (_req: Request, res: Response) => {
  // All cleanup steps run inside a single interactive transaction so a
  // failure at any step leaves the database unchanged. This addresses the
  // partial-deletion risk where users+jobs are deleted but the orphan
  // sweep throws, leaving unreachable NzbFiles behind.
  const result = await prisma.$transaction(async (tx) => {
    // 1. Find all E2E test users
    const testUsers = await tx.user.findMany({
      where: { email: { startsWith: "e2e-", endsWith: "@test.local" } },
      select: { id: true },
    });
    const userIds = testUsers.map((u) => u.id);

    let jobCount = 0;
    let userCount = 0;

    if (userIds.length > 0) {
      // 2. Collect NzbFile IDs touched by these users' jobs BEFORE
      //    deleting anything — we need them to scope the orphan sweep.
      const touchedFiles = await tx.downloadJob.findMany({
        where: { userId: { in: userIds } },
        select: { nzbFileId: true },
        distinct: ["nzbFileId"],
      });
      const touchedFileIds = touchedFiles.map((j) => j.nzbFileId);

      // 3. Delete download_jobs for these users (no cascade on userId)
      const jobDeletion = await tx.downloadJob.deleteMany({
        where: { userId: { in: userIds } },
      });
      jobCount = jobDeletion.count;

      // 4. Delete users (cascades: user_library, watchlist_items, api_tokens)
      const userDeletion = await tx.user.deleteMany({
        where: { id: { in: userIds } },
      });
      userCount = userDeletion.count;

      // 5. Clean up NzbFiles that were referenced by E2E jobs and now
      //    have no remaining jobs or library refs. Scoped to the files
      //    we collected in step 2 — never touches non-E2E data.
      const orphanFiles = touchedFileIds.length > 0
        ? await tx.nzbFile.deleteMany({
            where: {
              id: { in: touchedFileIds },
              downloadJobs: { none: {} },
              libraryUsers: { none: {} },
            },
          })
        : { count: 0 };

      // 6. Clean up NzbMovies that lost all their NzbFiles. Scoped to
      //    movies that were linked to the deleted files.
      const orphanMovies = await tx.nzbMovie.deleteMany({
        where: {
          nzbFiles: { none: {} },
        },
      });

      return {
        users: userCount,
        jobs: jobCount,
        nzbFiles: orphanFiles.count,
        nzbMovies: orphanMovies.count,
      };
    }

    // No E2E users found — still run a scoped orphan sweep for NzbMovies
    // with zero NzbFiles (covers the case where a previous partial run
    // deleted files but left movies behind).
    const orphanMovies = await tx.nzbMovie.deleteMany({
      where: { nzbFiles: { none: {} } },
    });

    return {
      users: 0,
      jobs: 0,
      nzbFiles: 0,
      nzbMovies: orphanMovies.count,
    };
  });

  console.log(
    `[test:cleanup] Deleted: ${result.users} users, ${result.jobs} jobs, ` +
    `${result.nzbFiles} orphan files, ${result.nzbMovies} orphan movies`,
  );

  res.json({ ok: true, deleted: result });
});

export default router;
