/**
 * Job Reconciler — detects and fixes stuck download jobs, plus manages the
 * needs_review lifecycle added in M021/S02.
 *
 * Runs periodically to catch jobs where the VPS died without callback:
 *
 * 1. **TMDB background retry**: needs_review jobs whose `tmdbRetryAfter` has
 *    elapsed get a fresh TMDB lookup. If it succeeds, the NzbFile is auto-
 *    assigned and all sibling needs_review jobs flip to queued. Runs before
 *    the expiry cleanup so recoverable jobs don't get expired by accident.
 *
 * 2. **Expired review cleanup**: needs_review jobs whose `reviewExpiresAt`
 *    has elapsed get transitioned to `expired` (a distinct terminal state —
 *    NOT `failed`, so NzbFile.failedAttempts is never incremented for
 *    uploads that never actually ran). If the cleanup leaves the NzbFile
 *    with no remaining active jobs, no movie, and no S3 object, the NzbFile
 *    row and the physical NZB on the service are deleted.
 *
 * 3. **Stale detection**: Jobs in non-terminal status (queued, provisioning,
 *    downloading, uploading) for longer than MAX_STALE_HOURS get checked.
 *
 * 4. **VPS health check**: For jobs with a Hetzner server ID, we verify
 *    the server still exists. If not → immediate failure.
 *
 * 5. **Hard timeout**: Jobs stuck longer than HARD_TIMEOUT_HOURS are failed
 *    regardless of VPS status (a download shouldn't take that long).
 *
 * 6. **Zombie VPS cleanup**: VPS servers without matching active jobs get deleted.
 */

import prisma from "./prisma.js";
import { getServer, deleteServer, listServers, isHetznerConfigured } from "./hetzner.js";
import { removeMapping } from "./caddy-mapping.js";
import { markJobFailed } from "./job-failure.js";
import { searchTmdbMovie } from "./tmdb.js";
import { parseNzbName } from "./nzb-parser.js";
import { deleteNzbFromService } from "./nzb-service.js";
import { provisionDownload } from "./provisioner.js";
import { deleteServiceTokens } from "./service-token.js";

// ── Configuration ───────────────────────────────────────────

/** Hours after which a job is considered potentially stale.
 * Set low (10 min) so manually deleted VPS are detected quickly. */
const STALE_CHECK_HOURS = 10 / 60; // 10 minutes

/** Hours after which a job is force-failed regardless */
const HARD_TIMEOUT_HOURS = 4;

/** Minutes a job's progress value may stay unchanged before we declare it
 * stuck. Targets jobs where `updatedAt` keeps getting bumped by VPN events
 * or other state writes while no bytes actually flow. Only applied to the
 * `downloading` and `uploading` phases — for `queued` / `provisioning`
 * a static progress=0 is normal. */
const PROGRESS_STAGNATION_MINUTES = 30;

/** Interval between reconciliation runs (ms) */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** In-memory snapshot of `{progress, firstSeen}` per job id used by the
 * progress-stagnation check. Reset on process restart — acceptable because
 * the 4h hard timeout remains as ultimate safety net. */
const progressSnapshots = new Map<string, { progress: number; firstSeen: number }>();

/** Test helper — clear the progress-stagnation snapshot map so each test
 * starts from a clean state. Not part of the public API. */
export function _resetProgressSnapshotsForTests(): void {
  progressSnapshots.clear();
}

// ── TMDB background retry configuration ────────────────────

/** Maximum number of TMDB retry attempts before giving up. After this, the
 * needs_review job waits for manual assignment only. */
const MAX_TMDB_RETRIES = 5;

/** Exponential-ish backoff schedule in milliseconds. Index = the delay that
 * applies AFTER the N-th failed attempt BEFORE the (N+1)-th attempt.
 * Five entries matches MAX_TMDB_RETRIES=5. BACKOFF[newCount - 1] gives the
 * delay to schedule after incrementing the retry counter. */
const TMDB_RETRY_BACKOFF_MS: readonly number[] = [
  60 * 1000,          //  1 min  — after 1st failure → 2nd attempt
  5 * 60 * 1000,      //  5 min  — after 2nd failure → 3rd attempt
  30 * 60 * 1000,     // 30 min  — after 3rd failure → 4th attempt
  2 * 60 * 60 * 1000, //  2 h    — after 4th failure → 5th attempt
  6 * 60 * 60 * 1000, //  6 h    — reserved (unused at MAX_TMDB_RETRIES=5)
];

// ── Reconciliation Logic ────────────────────────────────────

export interface ReconcileResult {
  checked: number;
  failed: number;
  zombiesDeleted: number;
  tmdbRetried: number;
  tmdbAutoAssigned: number;
  expired: number;
  orphansDeleted: number;
  details: string[];
}

/**
 * Retry TMDB lookups for needs_review jobs whose tmdbRetryAfter has elapsed.
 *
 * This handles the case where the /request endpoint got a transient TMDB
 * error (rate limit, 5xx, network) and deferred the lookup. For each eligible
 * NzbFile we re-run searchTmdbMovie with the parsed title. On success, the
 * NzbFile is auto-assigned and all sibling needs_review jobs flip to queued.
 * On failure, the retry counter increments and tmdbRetryAfter is pushed out
 * per the backoff schedule. After MAX_TMDB_RETRIES, the job stays in
 * needs_review and waits for manual assignment (tmdbRetryAfter = null).
 *
 * Processes one NzbFile per eligible job. If multiple users' jobs point at
 * the same NzbFile, they all benefit from a single successful retry.
 *
 * Safe to call concurrently — CAS + transaction guards in the inner updates.
 */
export async function retryTmdbForPendingReviews(
  result: ReconcileResult,
  now: Date = new Date(),
): Promise<void> {
  const eligibleJobs = await prisma.downloadJob.findMany({
    where: {
      status: "needs_review",
      tmdbRetryAfter: { not: null, lte: now },
      tmdbRetryCount: { lt: MAX_TMDB_RETRIES },
    },
    include: {
      nzbFile: { select: { id: true, hash: true, originalFilename: true, movieId: true } },
    },
  });

  // Dedupe by NzbFile — if multiple needs_review jobs share a hash, we only
  // run TMDB once per hash. The flip below will pick up all of them.
  const seenFiles = new Set<string>();

  for (const job of eligibleJobs) {
    if (seenFiles.has(job.nzbFileId)) continue;
    seenFiles.add(job.nzbFileId);
    result.tmdbRetried++;

    const hash = job.nzbFile.hash.slice(0, 12);

    // Race: the NzbFile was already assigned between the query and this
    // iteration (manual assign-movie, or a concurrent retry tick). Just
    // flip this job to queued — the NzbFile already has a movieId.
    if (job.nzbFile.movieId !== null) {
      await flipNeedsReviewJobsToQueued(job.nzbFileId);
      const msg = `TMDB retry skipped: NzbFile ${hash}... already assigned — flipped sibling jobs`;
      result.details.push(msg);
      console.log(`[reconciler] ${msg}`);
      continue;
    }

    const parsed = parseNzbName(job.nzbFile.originalFilename);
    const tmdbResult = await searchTmdbMovie(parsed.title, parsed.year);

    if (tmdbResult.status === "found") {
      // Success — auto-assign the NzbFile and flip all sibling jobs
      const assigned = await assignMovieToNzbFile(job.nzbFileId, tmdbResult.movie);
      if (assigned) {
        result.tmdbAutoAssigned++;
        const msg = `TMDB retry success: hash ${hash}... → auto-assigned to TMDB ${tmdbResult.movie.tmdbId} (${tmdbResult.movie.titleEn})`;
        result.details.push(msg);
        console.log(`[reconciler] ${msg}`);
      }
      continue;
    }

    // Failure (not_found, error, disabled) — bump retry counter and schedule
    // the next attempt. Apply to ALL jobs on this NzbFile that are still in
    // needs_review and still under the retry cap.
    const newCount = job.tmdbRetryCount + 1;
    // BACKOFF[newCount - 1] = delay after this failure before the next attempt.
    // Clamped defensively in case the schedule is ever shorter than MAX.
    const backoffIndex = Math.min(Math.max(newCount - 1, 0), TMDB_RETRY_BACKOFF_MS.length - 1);
    const newRetryAfter =
      newCount >= MAX_TMDB_RETRIES
        ? null
        : new Date(now.getTime() + TMDB_RETRY_BACKOFF_MS[backoffIndex]);

    await prisma.downloadJob.updateMany({
      where: {
        nzbFileId: job.nzbFileId,
        status: "needs_review",
        tmdbRetryCount: { lt: MAX_TMDB_RETRIES },
      },
      data: {
        tmdbRetryCount: { increment: 1 },
        tmdbRetryAfter: newRetryAfter,
      },
    });

    if (newCount >= MAX_TMDB_RETRIES) {
      const msg = `TMDB retry max reached: hash ${hash}... — waiting for manual assign`;
      result.details.push(msg);
      console.log(`[reconciler] ${msg}`);
    } else {
      const msg = `TMDB retry failed (attempt ${newCount}/${MAX_TMDB_RETRIES}): hash ${hash}... — next at ${newRetryAfter?.toISOString()}`;
      result.details.push(msg);
      console.log(`[reconciler] ${msg}`);
    }
  }
}

/**
 * Transaction helper: link an NzbFile to a TMDB movie (reusing or creating
 * the NzbMovie row) and flip all sibling needs_review jobs to queued.
 *
 * Mirrors the logic of the POST /downloads/jobs/:id/assign-movie endpoint
 * but without the HTTP layer or ownership checks. Used by the TMDB background
 * retry path.
 *
 * Returns true if the assignment succeeded (or raced with another caller and
 * we're now in a sensible state), false on unexpected error. The flipped
 * jobs are then triggered for provisioning in a fire-and-forget fashion.
 */
async function assignMovieToNzbFile(
  nzbFileId: string,
  tmdb: {
    tmdbId: number;
    imdbId: string | null;
    titleDe: string;
    titleEn: string;
    description: string;
    year: number | null;
    posterPath: string | null;
  },
): Promise<boolean> {
  let flippedJobIds: string[] = [];
  try {
    flippedJobIds = await prisma.$transaction(async (tx) => {
      // Fresh read
      const fresh = await tx.nzbFile.findUnique({
        where: { id: nzbFileId },
        select: { id: true, movieId: true },
      });
      if (!fresh) return [];

      // Race: already assigned — flip sibling jobs and return.
      if (fresh.movieId !== null) {
        const siblings = await tx.downloadJob.findMany({
          where: { nzbFileId, status: "needs_review" },
          select: { id: true },
        });
        await tx.downloadJob.updateMany({
          where: { nzbFileId, status: "needs_review" },
          data: {
            status: "queued",
            error: null,
            reviewExpiresAt: null,
            tmdbRetryAfter: null,
          },
        });
        return siblings.map((j) => j.id);
      }

      // Reuse-or-create NzbMovie on tmdbId unique.
      let movie = await tx.nzbMovie.findUnique({ where: { tmdbId: tmdb.tmdbId } });
      if (!movie) {
        try {
          movie = await tx.nzbMovie.create({
            data: {
              tmdbId: tmdb.tmdbId,
              imdbId: tmdb.imdbId,
              titleDe: tmdb.titleDe,
              titleEn: tmdb.titleEn,
              description: tmdb.description,
              year: tmdb.year,
              posterPath: tmdb.posterPath,
            },
          });
        } catch (err: any) {
          if (err?.code === "P2002") {
            movie = await tx.nzbMovie.findUniqueOrThrow({ where: { tmdbId: tmdb.tmdbId } });
          } else {
            throw err;
          }
        }
      }

      await tx.nzbFile.update({
        where: { id: nzbFileId },
        data: { movieId: movie.id },
      });

      const siblings = await tx.downloadJob.findMany({
        where: { nzbFileId, status: "needs_review" },
        select: { id: true },
      });

      await tx.downloadJob.updateMany({
        where: { nzbFileId, status: "needs_review" },
        data: {
          status: "queued",
          error: null,
          reviewExpiresAt: null,
          tmdbRetryAfter: null,
        },
      });

      return siblings.map((j) => j.id);
    });
  } catch (err: any) {
    console.error(`[reconciler] assignMovieToNzbFile failed for ${nzbFileId}:`, err);
    return false;
  }

  // Fire-and-forget provisioning (outside the transaction)
  for (const jobId of flippedJobIds) {
    provisionDownload(jobId).catch((err) => {
      console.error(`[reconciler] Auto-provision failed for flipped job ${jobId}:`, err);
    });
  }

  return true;
}

/**
 * Transaction helper: flip all needs_review jobs on an NzbFile to queued.
 * Used when the NzbFile was already assigned by another path and we just
 * want to catch our sibling job up.
 */
async function flipNeedsReviewJobsToQueued(nzbFileId: string): Promise<string[]> {
  let flippedIds: string[] = [];
  try {
    flippedIds = await prisma.$transaction(async (tx) => {
      const jobs = await tx.downloadJob.findMany({
        where: { nzbFileId, status: "needs_review" },
        select: { id: true },
      });
      await tx.downloadJob.updateMany({
        where: { nzbFileId, status: "needs_review" },
        data: {
          status: "queued",
          error: null,
          reviewExpiresAt: null,
          tmdbRetryAfter: null,
        },
      });
      return jobs.map((j) => j.id);
    });
  } catch (err: any) {
    console.error(`[reconciler] flipNeedsReviewJobsToQueued failed for ${nzbFileId}:`, err);
    return [];
  }

  for (const jobId of flippedIds) {
    provisionDownload(jobId).catch((err) => {
      console.error(`[reconciler] Auto-provision failed for flipped job ${jobId}:`, err);
    });
  }
  return flippedIds;
}

/**
 * Clean up needs_review jobs whose review window has expired.
 *
 * For each expired job:
 *  1. Transition to terminal status 'expired' (NOT 'failed' — we don't want
 *     to bump NzbFile.failedAttempts for an upload that never ran).
 *  2. If no other active jobs remain on the NzbFile AND movieId is still null
 *     AND s3Key is null, delete the orphan NzbFile and its physical NZB file
 *     on the nzb-service.
 *
 * Direct Prisma updates are used (not markJobFailed) because the latter
 * increments failedAttempts and auto-marks the NzbFile as broken after 3
 * failures. That's wrong semantics for expired reviews.
 */
export async function cleanupExpiredReviews(
  result: ReconcileResult,
  now: Date = new Date(),
): Promise<void> {
  const expiredJobs = await prisma.downloadJob.findMany({
    where: {
      status: "needs_review",
      reviewExpiresAt: { not: null, lte: now },
    },
    include: {
      nzbFile: { select: { id: true, hash: true, movieId: true, s3Key: true } },
    },
  });

  for (const job of expiredJobs) {
    const hash = job.nzbFile.hash.slice(0, 12);

    // Transition to 'expired' with CAS on status to avoid racing with a
    // concurrent assign-movie that might flip the job to queued.
    const cas = await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "needs_review" },
      data: {
        status: "expired",
        error: "Review-Zeit abgelaufen ohne manuelle Zuordnung.",
        completedAt: now,
      },
    });

    if (cas.count === 0) {
      // Someone else transitioned this job — leave it alone.
      console.log(`[reconciler] Expired review skipped: job ${job.id.slice(0, 8)} was already transitioned`);
      continue;
    }

    result.expired++;
    const expiredMsg = `Expired review: job ${job.id.slice(0, 8)} (${hash}...) → status=expired`;
    result.details.push(expiredMsg);
    console.log(`[reconciler] ${expiredMsg}`);

    // Check if we should clean up the NzbFile.
    // Any remaining active job (including other needs_review, queued, or in-flight)
    // pins the NzbFile. Same rule for s3Key — we never delete a file that's on S3.
    const remainingActiveJobs = await prisma.downloadJob.count({
      where: {
        nzbFileId: job.nzbFileId,
        status: { in: ["needs_review", "queued", "provisioning", "downloading", "uploading", "completed"] },
      },
    });

    if (remainingActiveJobs > 0) {
      const keepMsg = `Cleanup: kept NzbFile ${hash}... (still has ${remainingActiveJobs} active job(s))`;
      result.details.push(keepMsg);
      console.log(`[reconciler] ${keepMsg}`);
      continue;
    }

    // Re-read the NzbFile to see its latest movieId (could have been set
    // between our initial query and now).
    const freshFile = await prisma.nzbFile.findUnique({
      where: { id: job.nzbFileId },
      select: { id: true, movieId: true, s3Key: true, hash: true },
    });

    if (!freshFile) {
      // Already gone — idempotent.
      continue;
    }

    if (freshFile.movieId !== null) {
      const keepMsg = `Cleanup: kept NzbFile ${hash}... (was assigned to a movie in the meantime)`;
      result.details.push(keepMsg);
      console.log(`[reconciler] ${keepMsg}`);
      continue;
    }

    if (freshFile.s3Key !== null) {
      // Defensive: needs_review NzbFiles should never have an s3Key, but if
      // they do, don't delete.
      const keepMsg = `Cleanup: kept NzbFile ${hash}... (has s3Key ${freshFile.s3Key})`;
      result.details.push(keepMsg);
      console.log(`[reconciler] ${keepMsg}`);
      continue;
    }

    // Truly orphaned — delete the NzbFile row and the physical NZB file.
    try {
      await prisma.nzbFile.delete({ where: { id: freshFile.id } });
      result.orphansDeleted++;
      const deleteMsg = `Cleanup: deleted orphan NzbFile ${hash}... (no active jobs, no movie, no S3)`;
      result.details.push(deleteMsg);
      console.log(`[reconciler] ${deleteMsg}`);
    } catch (err: any) {
      console.error(`[reconciler] Failed to delete NzbFile ${freshFile.id}: ${err.message}`);
      continue;
    }

    // Fire-and-forget physical file delete on the nzb-service
    deleteNzbFromService(freshFile.hash).catch((err) => {
      console.error(`[reconciler] Physical NZB delete failed for ${hash}: ${err.message}`);
    });
  }
}

/**
 * Run one reconciliation pass.
 *
 * Safe to call concurrently — uses CAS updates so no double-transition.
 */
export async function reconcileStaleJobs(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checked: 0,
    failed: 0,
    zombiesDeleted: 0,
    tmdbRetried: 0,
    tmdbAutoAssigned: 0,
    expired: 0,
    orphansDeleted: 0,
    details: [],
  };

  // ── M021/S02: needs_review lifecycle ───────────────────────
  // Run TMDB retry BEFORE cleanup so recoverable jobs don't get expired
  // by accident. Both are safe to call with the same `now` timestamp.
  try {
    await retryTmdbForPendingReviews(result);
  } catch (err) {
    console.error("[reconciler] retryTmdbForPendingReviews failed:", err);
  }

  try {
    await cleanupExpiredReviews(result);
  } catch (err) {
    console.error("[reconciler] cleanupExpiredReviews failed:", err);
  }

  try {
    // Find non-terminal jobs
    const activeJobs = await prisma.downloadJob.findMany({
      where: {
        status: { in: ["queued", "provisioning", "downloading", "uploading"] },
      },
      include: {
        nzbFile: { select: { hash: true } },
      },
    });

    result.checked = activeJobs.length;

    const now = Date.now();

    for (const job of activeJobs) {
      const updatedAt = new Date(job.updatedAt).getTime();
      const ageHours = (now - updatedAt) / (1000 * 60 * 60);
      const hash = job.nzbFile.hash.slice(0, 12);

      // Hard timeout — fail regardless
      if (ageHours >= HARD_TIMEOUT_HOURS) {
        const failResult = await markJobFailed({
          jobId: job.id,
          error: `Timeout: Job steckte ${ageHours.toFixed(1)}h in Status '${job.status}' fest. Automatisch abgebrochen.`,
          source: "reconciler",
          expectedStatus: job.status,
        });

        if (failResult.changed) {
          result.failed++;
          const msg = `Hard timeout: job ${job.id.slice(0, 8)} (${hash}...) — ${ageHours.toFixed(1)}h in ${job.status}`;
          result.details.push(msg);
          console.log(`[reconciler] ${msg}`);
        }
        continue;
      }

      // Stale check — verify VPS still exists
      if (ageHours >= STALE_CHECK_HOURS && job.hetznerServerId && isHetznerConfigured()) {
        try {
          const server = await getServer(job.hetznerServerId);

          if (!server) {
            // VPS is gone but job still active → fail it
            const failResult = await markJobFailed({
              jobId: job.id,
              error: `Download-Server (${job.hetznerServerId}) existiert nicht mehr. Download abgebrochen.`,
              source: "reconciler",
              expectedStatus: job.status,
            });

            if (failResult.changed) {
              result.failed++;
              const msg = `VPS gone: job ${job.id.slice(0, 8)} (${hash}...) — server ${job.hetznerServerId} not found`;
              result.details.push(msg);
              console.log(`[reconciler] ${msg}`);
            }
          } else if (server.status === "off" || server.status === "deleting") {
            // VPS exists but is shutting down
            const failResult = await markJobFailed({
              jobId: job.id,
              error: `Download-Server ist ${server.status}. Download abgebrochen.`,
              source: "reconciler",
              expectedStatus: job.status,
            });

            if (failResult.changed) {
              result.failed++;
              const msg = `VPS ${server.status}: job ${job.id.slice(0, 8)} (${hash}...) — server ${job.hetznerServerId}`;
              result.details.push(msg);
              console.log(`[reconciler] ${msg}`);
            }
          }
        } catch (err: any) {
          // Hetzner API error — don't fail the job, just log
          console.warn(`[reconciler] Hetzner check failed for server ${job.hetznerServerId}: ${err.message}`);
        }
      }

      // Progress stagnation — only meaningful while bytes should be flowing.
      // `updatedAt` can advance independently of `progress` (e.g. VPN watchdog
      // touches the row), so we track the progress value itself across runs.
      if (job.status === "downloading" || job.status === "uploading") {
        const snap = progressSnapshots.get(job.id);
        if (!snap || snap.progress !== job.progress) {
          progressSnapshots.set(job.id, { progress: job.progress, firstSeen: now });
        } else {
          const stagnantMs = now - snap.firstSeen;
          if (stagnantMs >= PROGRESS_STAGNATION_MINUTES * 60 * 1000) {
            const stagnantMin = stagnantMs / (60 * 1000);
            const failResult = await markJobFailed({
              jobId: job.id,
              error: `Fortschritt steckt seit ${stagnantMin.toFixed(0)}min bei ${job.progress}% fest. Automatisch abgebrochen.`,
              source: "reconciler",
              expectedStatus: job.status,
            });

            if (failResult.changed) {
              result.failed++;
              const msg = `Progress stagnation: job ${job.id.slice(0, 8)} (${hash}...) — ${job.progress}% for ${stagnantMin.toFixed(0)}min in ${job.status}`;
              result.details.push(msg);
              console.log(`[reconciler] ${msg}`);
              progressSnapshots.delete(job.id);
            }
            continue;
          }
        }
      }

      // Queued jobs without VPS that are stale → provisioning probably failed silently
      if (ageHours >= STALE_CHECK_HOURS && job.status === "queued") {
        const failResult = await markJobFailed({
          jobId: job.id,
          error: `Job blieb ${ageHours.toFixed(1)}h in 'queued' — Provisioning wurde nie gestartet.`,
          source: "reconciler",
          expectedStatus: "queued",
        });

        if (failResult.changed) {
          result.failed++;
          const msg = `Stale queued: job ${job.id.slice(0, 8)} (${hash}...) — ${ageHours.toFixed(1)}h`;
          result.details.push(msg);
          console.log(`[reconciler] ${msg}`);
        }
      }
    }

    // Prune progress snapshots for jobs no longer in the active set
    // (terminal, deleted, or otherwise gone) — keeps the map bounded.
    const activeIds = new Set(activeJobs.map((j) => j.id));
    for (const id of progressSnapshots.keys()) {
      if (!activeIds.has(id)) progressSnapshots.delete(id);
    }

    // ── Zombie VPS cleanup ──────────────────────────────────
    if (isHetznerConfigured()) {
      try {
        const servers = await listServers("purpose=openmedia-download");

        for (const server of servers) {
          const jobId = server.labels["job-id"];
          if (!jobId) continue;

          // Check if the job is still active
          const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });

          // If job doesn't exist or is terminal → VPS is a zombie
          if (!job || job.status === "completed" || job.status === "failed") {
            try {
              const deleted = await deleteServer(server.id);
              if (deleted) {
                result.zombiesDeleted++;
                const msg = `Zombie VPS deleted: ${server.name} (id: ${server.id}) — job ${jobId?.slice(0, 8) || "?"}`;
                result.details.push(msg);
                console.log(`[reconciler] ${msg}`);

                // Clean up Caddy reverse proxy mapping
                try {
                  await removeMapping(server.name);
                } catch {
                  // Best-effort — mapping may not exist
                }

                // Delete service tokens (non-fatal)
                try {
                  await deleteServiceTokens(jobId);
                } catch {
                  // Best-effort — tokens may already be gone
                }
              }
            } catch (delErr: any) {
              console.warn(`[reconciler] Zombie delete failed: ${server.id} — ${delErr.message}`);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[reconciler] Zombie scan failed: ${err.message}`);
      }

      // ── Upload zombie VPS cleanup ──────────────────────────
      try {
        const uploadServers = await listServers("purpose=openmedia-upload");

        for (const server of uploadServers) {
          const jobId = server.labels["uploadJobId"];
          if (!jobId) continue;

          const job = await prisma.uploadJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });

          if (!job || job.status === "completed" || job.status === "failed") {
            try {
              const deleted = await deleteServer(server.id);
              if (deleted) {
                result.zombiesDeleted++;
                const msg = `Zombie upload VPS deleted: ${server.name} (id: ${server.id}) — job ${jobId?.slice(0, 8) || "?"}`;
                result.details.push(msg);
                console.log(`[reconciler] ${msg}`);

                // Delete service tokens (non-fatal)
                try {
                  await deleteServiceTokens(jobId);
                } catch {
                  // Best-effort
                }
              }
            } catch (delErr: any) {
              console.warn(`[reconciler] Upload zombie delete failed: ${server.id} — ${delErr.message}`);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[reconciler] Upload zombie scan failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("[reconciler] Reconciliation failed:", err);
  }

  return result;
}

// ── Scheduler ───────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic reconciler.
 *
 * Runs immediately once, then every RECONCILE_INTERVAL_MS.
 */
export function startReconciler(): void {
  if (intervalHandle) {
    console.log("[reconciler] Already running.");
    return;
  }

  console.log(`[reconciler] Starting (check every ${RECONCILE_INTERVAL_MS / 1000}s, stale=${STALE_CHECK_HOURS}h, timeout=${HARD_TIMEOUT_HOURS}h)`);

  // Run once immediately
  reconcileStaleJobs().then((r) => {
    if (r.failed > 0 || r.zombiesDeleted > 0) {
      console.log(`[reconciler] Initial run: ${r.failed} jobs failed, ${r.zombiesDeleted} zombies cleaned`);
    }
  });

  intervalHandle = setInterval(async () => {
    const r = await reconcileStaleJobs();
    if (r.failed > 0 || r.zombiesDeleted > 0) {
      console.log(`[reconciler] Periodic: ${r.failed} jobs failed, ${r.zombiesDeleted} zombies cleaned`);
    }
  }, RECONCILE_INTERVAL_MS);
}

/**
 * Stop the periodic reconciler.
 */
export function stopReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[reconciler] Stopped.");
  }
}
