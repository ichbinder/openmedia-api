import { createHash } from "crypto";
import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { parseNzbName } from "../lib/nzb-parser.js";
import { sendToSabnzbd, getSabnzbdStatus, getSabnzbdConfigSummary } from "../lib/sabnzbd.js";
import { searchTmdbMovie, searchTmdbMovieById, type TmdbMovieResult } from "../lib/tmdb.js";
import { markJobFailed } from "../lib/job-failure.js";
import { computeReviewExpiresAt, computeInitialTmdbRetryAfter } from "../lib/review-config.js";
import { storeNzbInService } from "../lib/nzb-service.js";
import { getUploadVpsConfig } from "../lib/vps-config.js";

const router = Router();

router.use(requireAuth);

/**
 * Resolve a movie via TMDB lookup, returning one of three outcomes.
 *
 * Cases:
 * 1. **tmdb-found**: TMDB returned a single matching movie. The caller decides
 *    whether to reuse an existing NzbMovie row (matched by tmdbId) or create a
 *    new one — that decision happens inside the transaction to avoid a TOCTOU
 *    race on the tmdbId unique constraint.
 * 2. **needs-review** (`reason: 'not-found'`): TMDB definitively had no match.
 *    The caller must NOT create a Phantom NzbMovie. Instead the NzbFile is
 *    persisted with movieId=null and the DownloadJob enters status='needs_review'.
 *    The user is expected to assign a movie manually via the Frontend.
 * 3. **needs-review** (`reason: 'error'`): TMDB call failed for transient
 *    reasons (rate limit, network, 5xx). Same as (2) at the data-model level
 *    but additionally signals that a background retry should be scheduled —
 *    the reconciler will attempt the lookup again later, and if successful
 *    auto-assign the movie without user interaction.
 *
 * Note: even if `parsedTitle` is empty, an `error` from TMDB still routes to
 * needs-review (rather than the previous silent fallback) because the user
 * must be the one to decide what film this NZB represents.
 */
async function resolveMovieFromTmdb(
  parsedTitle: string,
  parsedYear: number | null,
  fallbackTitle: string,
): Promise<
  | { source: "tmdb-found"; tmdb: TmdbMovieResult }
  | { source: "needs-review"; reason: "not-found" | "error"; errorDetail?: string }
  | { source: "tmdb-disabled"; reason: string }
> {
  // Use parsed title if available, fallback to user-supplied title
  const searchTitle = parsedTitle || fallbackTitle;

  if (!searchTitle) {
    console.log(`[matching] No usable title for TMDB lookup — marking needs_review`);
    return { source: "needs-review", reason: "not-found" };
  }

  const result = await searchTmdbMovie(searchTitle, parsedYear);

  if (result.status === "disabled") {
    console.error(
      `[matching] TMDB is disabled (${result.reason}) — cannot process upload`
    );
    return { source: "tmdb-disabled", reason: result.reason };
  }

  if (result.status === "error") {
    console.warn(
      `[matching] TMDB error for "${searchTitle}" (${parsedYear || "?"}): ${result.reason} — marking needs_review (will retry in background)`
    );
    return { source: "needs-review", reason: "error", errorDetail: result.reason };
  }

  if (result.status === "not_found") {
    console.log(
      `[matching] No TMDB match for "${searchTitle}" (${parsedYear || "?"}) — marking needs_review`
    );
    return { source: "needs-review", reason: "not-found" };
  }

  // TMDB found the movie — return the data; reuse vs create decided inside the
  // transaction to avoid TOCTOU races on the tmdbId unique constraint.
  console.log(
    `[matching] TMDB ${result.movie.tmdbId} matched "${result.movie.titleEn}" — will reuse or create inside tx`
  );
  return { source: "tmdb-found", tmdb: result.movie };
}

const NZB_API_URL = process.env.NZB_API_URL || "http://localhost:4100";

// ---------------------------------------------------------------------------
// Valid status transitions for download jobs
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["needs_review", "queued", "provisioning", "downloading", "uploading", "completed", "failed", "expired"] as const;
type JobStatus = (typeof VALID_STATUSES)[number];

/** Map of allowed status transitions: current → allowed next statuses */
const STATUS_TRANSITIONS: Record<string, JobStatus[]> = {
  // needs_review → queued (movie was assigned manually or via background TMDB retry)
  // needs_review → expired (review window elapsed without assignment — distinct
  //                 from 'failed' because no download actually failed, so the
  //                 NzbFile's failedAttempts counter must NOT be incremented)
  needs_review: ["queued", "expired"],
  queued: ["provisioning", "failed"],
  provisioning: ["downloading", "failed"],
  downloading: ["uploading", "failed"],
  uploading: ["completed", "failed"],
  // Terminal states — no transitions out
  completed: [],
  failed: [],
  expired: [],
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

    // NzbFile must be assigned to a movie before it can be downloaded.
    // Files in needs_review state (movieId=null) require manual TMDB assignment first.
    if (!nzbFile.movie) {
      res.status(409).json({
        error: "NZB-Datei wartet auf manuelle Film-Zuordnung.",
        reason: "needs_review",
        hint: "Ordne der NZB einen Film zu, bevor der Download gestartet werden kann.",
      });
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

    // NzbFile must be assigned to a movie before a download job can be created.
    // Files in needs_review state (movieId=null) must be routed through the
    // manual assignment endpoint instead.
    if (!nzbFile.movieId) {
      res.status(409).json({
        error: "NZB-Datei wartet auf manuelle Film-Zuordnung.",
        reason: "needs_review",
        hint: "Ordne der NZB einen Film zu, bevor ein Download-Job erstellt werden kann.",
      });
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

    // nzbFile.movie is guaranteed non-null here (guarded above).
    const movieTitle = nzbFile.movie?.titleEn ?? "unknown";
    console.log(`[download-job] Created: ${result.job.id} for ${movieTitle} (${nzbFile.hash.slice(0, 12)}...)`);

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

// ---------------------------------------------------------------------------
// NZB Request — accept raw NZB content from browser extension
// ---------------------------------------------------------------------------

/**
 * POST /downloads/request
 *
 * Accepts NZB file content directly (as JSON string), creates the necessary
 * DB records (NzbMovie + NzbFile + DownloadJob), and triggers auto-provisioning.
 * Designed for the OpenMedia browser extension which sends NZBs found on indexer sites.
 *
 * Body: { nzbContent: string, title: string, password?: string, filename?: string }
 */
router.post("/request", async (req: AuthRequest, res: Response) => {
  try {
    const { nzbContent, title, password, filename } = req.body;

    // --- Validation ---
    if (!nzbContent || typeof nzbContent !== "string") {
      res.status(400).json({ error: "nzbContent ist erforderlich (string)." });
      return;
    }
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title ist erforderlich (string)." });
      return;
    }
    if (filename !== undefined && (typeof filename !== "string" || filename.length === 0)) {
      res.status(400).json({ error: "filename muss ein nicht-leerer String sein." });
      return;
    }
    if (nzbContent.length < 50) {
      res.status(400).json({ error: "nzbContent ist zu kurz — ungültiges NZB." });
      return;
    }

    // NZB XML sanity check — must contain an <nzb root element
    if (!nzbContent.includes("<nzb")) {
      res.status(400).json({ error: "nzbContent scheint kein gültiges NZB-XML zu sein." });
      return;
    }

    // --- Hash for deduplication ---
    const hash = createHash("sha256").update(nzbContent).digest("hex");
    console.log(`[nzb-request] Processing: "${title}" (hash: ${hash.slice(0, 12)}...)`);

    // --- Check for existing NzbFile with same hash (serializable to prevent race conditions) ---
    const existingFile = await prisma.nzbFile.findUnique({
      where: { hash },
      include: { movie: true },
    });

    if (existingFile) {
      // --- Check if NzbFile is marked as broken (≥3 failures) ---
      // Note: if the file is already on S3, broken status is irrelevant —
      // the user can still stream it. So we check S3 first.
      // --- Check if file is already on S3 (no download needed) ---
      if (existingFile.s3Key) {
        try {
          const { fileExists } = await import("../lib/s3.js");
          const onS3 = await fileExists(existingFile.s3Key, existingFile.s3Bucket || undefined);

          if (onS3) {
            console.log(
              `[nzb-request] Already on S3: ${hash.slice(0, 12)}... → ${existingFile.s3Key} — skipping download`
            );
            res.status(200).json({
              alreadyAvailable: true,
              message: "Film ist bereits heruntergeladen und verfügbar.",
              movie: existingFile.movie,
              nzbFile: {
                id: existingFile.id,
                hash: existingFile.hash,
                resolution: existingFile.resolution,
                s3Key: existingFile.s3Key,
                s3StreamKey: existingFile.s3StreamKey,
              },
            });
            return;
          }

          // S3 key set but file gone (LRU cleanup) — reset DB and continue with download
          console.warn(
            `[nzb-request] S3 key set but file gone: ${hash.slice(0, 12)}... → resetting and re-downloading`
          );
          await prisma.nzbFile.update({
            where: { id: existingFile.id },
            data: { s3Key: null, s3StreamKey: null, s3Bucket: null, fileExtension: null, downloadedAt: null },
          });
        } catch (err: any) {
          // S3 not configured or unreachable — continue with download as fallback
          console.warn(`[nzb-request] S3 check failed: ${err.message} — continuing with download`);
        }
      }

      // --- Reject broken NzbFiles (≥3 failures) ---
      // The file isn't on S3 and is known to be broken. Don't waste a VPS.
      if (existingFile.status === "broken") {
        console.log(
          `[nzb-request] Rejected broken NZB: ${hash.slice(0, 12)}... (${existingFile.failedAttempts} failures)`
        );
        res.status(410).json({
          error: "Diese NZB-Datei ist als kaputt markiert.",
          reason: existingFile.brokenReason || `Download ${existingFile.failedAttempts}x fehlgeschlagen.`,
          failedAttempts: existingFile.failedAttempts,
          movie: existingFile.movie,
          hint: "Bitte suche eine andere NZB-Version dieses Films.",
        });
        return;
      }

      // File already known — atomic check-and-create inside a transaction.
      // We re-read the NzbFile's movieId INSIDE the transaction so a concurrent
      // /assign-movie call (landing in S02) can't create a TOCTOU where we
      // decide "needs_review" based on a stale null and leave a stuck job.
      let reuseResult;
      try {
        reuseResult = await prisma.$transaction(async (tx) => {
          // Fresh read: movieId may have been set between the initial findUnique
          // and the start of this transaction (concurrent assign-movie, reconciler
          // TMDB retry, etc.).
          const freshFile = await tx.nzbFile.findUnique({
            where: { id: existingFile.id },
            select: { id: true, movieId: true },
          });

          if (!freshFile) {
            // Extremely unlikely — NzbFile vanished between reads. Treat as not found.
            return { missing: true as const };
          }

          const reuseNeedsReview = freshFile.movieId === null;

          // Cross-user conflict: any active running download for this file blocks
          // a new job (the second user should wait for the first download to
          // finish, then they share the result via S3).
          const runningJob = await tx.downloadJob.findFirst({
            where: {
              nzbFileId: existingFile.id,
              status: { in: ["queued", "provisioning", "downloading", "uploading"] },
            },
          });

          if (runningJob) {
            return { conflict: true as const, activeJob: runningJob };
          }

          // Per-user needs_review check: if THIS user already has a pending
          // review for the same file, surface that existing job rather than
          // spamming a duplicate row. Other users may have their own review
          // jobs in parallel — that's intentional.
          const ownReview = await tx.downloadJob.findFirst({
            where: {
              nzbFileId: existingFile.id,
              status: "needs_review",
              userId: req.user?.userId || null,
            },
          });

          if (ownReview) {
            return { conflict: true as const, activeJob: ownReview };
          }

          const job = await tx.downloadJob.create({
            data: {
              nzbFileId: existingFile.id,
              userId: req.user?.userId || null,
              ...(reuseNeedsReview && {
                status: "needs_review",
                reviewExpiresAt: computeReviewExpiresAt(),
                // No retry hint here — we don't know whether the original
                // upload failed via TMDB error or not_found. The reconciler
                // will only retry rows whose tmdbRetryAfter is set.
              }),
            },
            include: { nzbFile: { include: { movie: true } } },
          });

          return { conflict: false as const, job, reuseNeedsReview };
        }, { isolationLevel: "Serializable" });
      } catch (err: any) {
        if (err?.code === "P2034" || err?.code === "40001") {
          res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
          return;
        }
        throw err;
      }

      if ("missing" in reuseResult) {
        res.status(404).json({ error: "NZB-Datei wurde inzwischen entfernt." });
        return;
      }

      if (reuseResult.conflict) {
        res.status(409).json({
          error: "Es läuft bereits ein Download für diese Datei.",
          existingJobId: reuseResult.activeJob.id,
          existingStatus: reuseResult.activeJob.status,
        });
        return;
      }

      const reuseNeedsReview = reuseResult.reuseNeedsReview;

      if (reuseNeedsReview) {
        console.log(
          `[nzb-request] Reuse needs_review NzbFile ${hash.slice(0, 12)}... → new job ${reuseResult.job.id} (needs_review)`
        );
      } else {
        console.log(`[nzb-request] Reusing existing NzbFile ${hash.slice(0, 12)}... → new job ${reuseResult.job.id}`);
      }

      // Ensure NZB exists on NZB service (may have been imported without it)
      storeNzbInService(hash, nzbContent).catch((err) => {
        console.error(`[nzb-request] Unexpected error storing NZB: ${err}`);
      });

      res.status(201).json({
        job: serializeJob(reuseResult.job),
        reused: true,
        needsReview: reuseNeedsReview,
      });

      // Trigger auto-provisioner — but skip needs_review jobs.
      if (!reuseNeedsReview && process.env.AUTO_PROVISION !== "false") {
        import("../lib/provisioner.js").then(({ provisionDownload }) => {
          provisionDownload(reuseResult.job.id).catch((err) => {
            console.error("[nzb-request] Auto-provision failed:", err);
          });
        }).catch((err) => {
          console.error("[nzb-request] Failed to load provisioner module:", err);
        });
      }
      return;
    }

    // --- Parse filename for metadata (if provided) ---
    const effectiveFilename = filename || `${title}.nzb`;
    const parsed = parseNzbName(effectiveFilename);

    // --- Resolve movie via TMDB (or mark for review) ---
    const movieResolution = await resolveMovieFromTmdb(parsed.title, parsed.year, title);

    // TMDB is completely disabled (no API key configured). This is a server
    // misconfiguration, not a transient or "no match" condition — fail hard
    // so the ops team notices.
    if (movieResolution.source === "tmdb-disabled") {
      res.status(503).json({
        error: "TMDB-Matching ist nicht verfügbar — Server-Konfiguration fehlt.",
        reason: "tmdb_disabled",
        hint: "Der Administrator muss TMDB_API_KEY setzen.",
      });
      return;
    }

    const isNeedsReview = movieResolution.source === "needs-review";

    // --- Create NzbMovie (or reuse existing) + NzbFile + DownloadJob in one transaction ---
    // For needs-review uploads, NzbMovie is skipped entirely and NzbFile is created
    // with movieId=null. The DownloadJob is still created so the user sees it on the
    // downloads page, but it enters status='needs_review' and is not provisioned.
    const result = await prisma.$transaction(async (tx) => {
      let movieId: string | null = null;
      let movie: { id: string; titleEn: string } | null = null;

      if (movieResolution.source === "tmdb-found") {
        // Atomic reuse-or-create on the tmdbId unique constraint.
        // Handles TOCTOU race: if findUnique returns null but another request
        // creates the same tmdbId between findUnique and create, we catch P2002
        // and re-fetch the winner.
        const t = movieResolution.tmdb;
        const existing = await tx.nzbMovie.findUnique({ where: { tmdbId: t.tmdbId } });

        if (existing) {
          movie = existing;
          console.log(
            `[matching] TMDB ${t.tmdbId} → reusing existing NzbMovie ${existing.id.slice(0, 8)}...`
          );
        } else {
          try {
            movie = await tx.nzbMovie.create({
              data: {
                tmdbId: t.tmdbId,
                imdbId: t.imdbId,
                titleDe: t.titleDe,
                titleEn: t.titleEn,
                description: t.description,
                year: t.year,
                posterPath: t.posterPath,
              },
            });
            console.log(`[matching] TMDB ${t.tmdbId} → created new NzbMovie ${movie.id.slice(0, 8)}...`);
          } catch (err: any) {
            // P2002: unique constraint — another request won the race
            if (err?.code === "P2002") {
              movie = await tx.nzbMovie.findUniqueOrThrow({ where: { tmdbId: t.tmdbId } });
              console.log(
                `[matching] TMDB ${t.tmdbId} → race detected, reusing winner ${movie.id.slice(0, 8)}...`
              );
            } else {
              throw err;
            }
          }
        }
        movieId = movie.id;
      }
      // else: needs-review — NzbMovie is intentionally not created. The user must
      // assign a movie via POST /downloads/jobs/:id/assign-movie before the job runs.

      const nzbFile = await tx.nzbFile.create({
        data: {
          movieId,
          hash,
          originalFilename: effectiveFilename,
          fileSize: BigInt(Buffer.byteLength(nzbContent, "utf-8")),
          resolution: parsed.resolution,
          audioLanguages: parsed.audioLanguages,
          codec: parsed.codec,
          source: "external",
          releaseType: parsed.source || null,
        },
      });

      const job = await tx.downloadJob.create({
        data: {
          nzbFileId: nzbFile.id,
          userId: req.user?.userId || null,
          // needs_review jobs wait for manual assignment or background TMDB retry.
          // The reconciler will fail and clean them up after reviewExpiresAt.
          ...(isNeedsReview && {
            status: "needs_review",
            reviewExpiresAt: computeReviewExpiresAt(),
            // Only schedule a background retry for transient TMDB errors.
            // 'not-found' is a definitive answer — no automatic retry, the user
            // must intervene manually.
            ...(movieResolution.reason === "error" && {
              tmdbRetryAfter: computeInitialTmdbRetryAfter(),
            }),
          }),
        },
      });

      return { movie, nzbFile, job };
    });

    if (isNeedsReview) {
      console.log(
        `[nzb-request] Created (needs_review): file=${result.nzbFile.id} job=${result.job.id} ` +
        `"${title}" (${parsed.resolution || "unknown"})`
      );
    } else {
      console.log(
        `[nzb-request] Created: movie=${result.movie?.id} file=${result.nzbFile.id} job=${result.job.id} ` +
        `"${title}" (${parsed.resolution || "unknown"})`
      );
    }

    // --- Store NZB in NZB service (non-blocking) ---
    // We always store the file, even for needs_review uploads — the assignment
    // step doesn't re-upload it, it just links it to a movie.
    storeNzbInService(hash, nzbContent).catch((err) => {
      console.error(`[nzb-request] Unexpected error storing NZB: ${err}`);
    });

    // Reload job with relations for response
    const fullJob = await prisma.downloadJob.findUnique({
      where: { id: result.job.id },
      include: { nzbFile: { include: { movie: true } } },
    });

    if (!fullJob) {
      res.status(500).json({ error: "Job wurde erstellt, konnte aber nicht geladen werden." });
      return;
    }

    res.status(201).json({
      job: serializeJob(fullJob),
      reused: false,
      needsReview: isNeedsReview,
    });

    // Trigger auto-provisioner — but NOT for needs_review jobs.
    // They wait until a movie is manually assigned (or auto-retry succeeds).
    if (!isNeedsReview && process.env.AUTO_PROVISION !== "false") {
      import("../lib/provisioner.js").then(({ provisionDownload }) => {
        provisionDownload(result.job.id).catch((err) => {
          console.error("[nzb-request] Auto-provision failed:", err);
        });
      }).catch((err) => {
        console.error("[nzb-request] Failed to load provisioner module:", err);
      });
    }
  } catch (err: any) {
    // Handle hash uniqueness race condition
    if (err?.code === "P2002") {
      res.status(409).json({ error: "NZB-Datei wurde gleichzeitig von einem anderen Request erstellt." });
      return;
    }
    console.error("[nzb-request] Error:", err);
    res.status(500).json({ error: "Fehler beim Verarbeiten des NZB-Uploads." });
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
          include: { movie: { select: { id: true, tmdbId: true, titleDe: true, titleEn: true, year: true, posterPath: true } } },
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
    const { status, error: errorMsg, progress, s3Key, s3StreamKey, s3Bucket, fileExtension, hetznerServerId, hetznerServerIp } = req.body;

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

    // needs_review jobs must not be transitioned via PATCH.
    // The only valid transitions out of needs_review are:
    //   - needs_review → queued  via POST /downloads/jobs/:id/assign-movie (S02)
    //   - needs_review → expired via the reconciler cleanup loop           (S02)
    // Allowing PATCH would let a client bypass the assign flow (landing a job in
    // queued without a movie) or increment the broken counter on an upload that
    // never actually ran.
    if (currentJob.status === "needs_review") {
      res.status(409).json({
        error: "needs_review Jobs können nicht per PATCH geändert werden.",
        reason: "needs_review",
        hint: "Nutze POST /downloads/jobs/:id/assign-movie um eine TMDB-Zuordnung zu setzen.",
      });
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
            s3StreamKey: s3StreamKey ? String(s3StreamKey) : null,
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

      // Auto-trigger Usenet re-upload for external NZBs (M025).
      // Only trigger if: (1) NzbFile.source === 'external' (not our own),
      // (2) no NzbFile with source='own' exists for this Movie,
      // (3) s3Key is set, (4) Hetzner is configured.
      try {
        const nzbFile = await prisma.nzbFile.findUnique({
          where: { id: currentJob.nzbFileId },
          select: { source: true, s3Key: true, hash: true, movieId: true },
        });

        if (nzbFile && nzbFile.source === "external" && nzbFile.s3Key) {
          const { isHetznerConfigured, provisionUploadVps } = await import("../lib/hetzner.js");
          if (isHetznerConfigured()) {
            // Atomically check/create upload job in a transaction
            const uploadJob = await prisma.$transaction(async (tx) => {
              const nzb = await tx.nzbFile.findUnique({
                where: { id: currentJob.nzbFileId },
                select: { source: true, s3Key: true, hash: true, movieId: true },
              });
              if (!nzb || nzb.source === "own" || !nzb.s3Key) return null;

              // Check: does this Movie already have a healthy own version?
              // Expired/broken own versions don't count — their Usenet content is unavailable
              if (nzb.movieId) {
                const ownVersion = await tx.nzbFile.findFirst({
                  where: {
                    movieId: nzb.movieId,
                    source: "own",
                    status: { notIn: ["expired", "broken"] },
                  },
                  select: { id: true },
                });
                if (ownVersion) return null; // already have healthy own version for this movie
              }

              // Check: is there already a running/pending upload?
              const existingJob = await tx.uploadJob.findFirst({
                where: { nzbFileId: currentJob.nzbFileId, status: { in: ["queued", "running"] } },
              });
              if (existingJob) return null;

              return tx.uploadJob.create({
                data: {
                  nzbFileId: currentJob.nzbFileId,
                  movieId: nzb.movieId,
                  status: "queued",
                },
              });
            });

            if (!uploadJob) {
              console.log(`[auto-upload] Skipping — healthy own version exists, or upload already running`);
            } else {
              console.log(`[auto-upload] Triggering Usenet re-upload for NzbFile ${nzbFile.hash}`);

              // Re-fetch nzbFile.s3Key since we're outside the transaction now
              const nzbForProvision = await prisma.nzbFile.findUnique({
                where: { id: currentJob.nzbFileId },
                select: { hash: true, s3Key: true },
              });
              if (nzbForProvision?.s3Key) {
                const uploadConfig = await getUploadVpsConfig();

                if (uploadConfig) {
                  try {
                    const result = await provisionUploadVps({
                      uploadJobId: uploadJob.id,
                      nzbFileHash: nzbForProvision.hash,
                      s3Key: nzbForProvision.s3Key,
                      apiBaseUrl: uploadConfig.apiBaseUrl,
                      apiToken: uploadConfig.apiToken,
                      s3AccessKey: uploadConfig.s3AccessKey,
                      s3SecretKey: uploadConfig.s3SecretKey,
                      s3Endpoint: uploadConfig.s3Endpoint,
                      s3Bucket: uploadConfig.s3Bucket,
                      nzbServiceUrl: uploadConfig.nzbServiceUrl,
                      nzbServiceToken: uploadConfig.nzbServiceToken,
                      usenetProviders: uploadConfig.usenetProviders,
                    });
                    await prisma.uploadJob.update({
                      where: { id: uploadJob.id },
                      data: {
                        status: "running",
                        hetznerServerId: result.server.id,
                        hetznerServerIp: result.server.publicIpv4,
                        startedAt: new Date(),
                      },
                    });
                    console.log(`[auto-upload] Upload VPS provisioned: ${result.server.name} (id=${result.server.id})`);
                  } catch (provErr) {
                    console.error(`[auto-upload] VPS provisioning failed: ${(provErr as Error).message}`);
                    // UploadJob stays queued — reconciler can retry later
                  }
                } else {
                  console.warn(`[auto-upload] Upload config incomplete — UploadJob ${uploadJob.id} stays queued`);
                }
              } else {
                console.warn(`[auto-upload] NzbFile has no s3Key after transaction`);
              }
            }
          } else {
            console.log(`[auto-upload] Hetzner not configured — skipping upload trigger for ${nzbFile.hash}`);
          }
        } else if (nzbFile && nzbFile.source === "own") {
          console.log(`[auto-upload] NzbFile ${nzbFile.hash} source=own — skipping re-upload`);
        } else if (nzbFile && !nzbFile.s3Key) {
          console.log(`[auto-upload] NzbFile ${nzbFile.hash} has no s3Key — skipping`);
        }
      } catch (uploadErr) {
        console.error("[auto-upload] Failed to create upload job:", uploadErr);
        // Non-blocking — download completion should not fail because upload trigger failed
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

    // On failed: handle two cases differently
    // 1. New failure (status transition X → failed): use markJobFailed helper
    //    which atomically transitions, increments failedAttempts, and auto-marks broken
    // 2. Same-status update (failed → failed for progress/metadata): plain updateMany
    //    without counter increment
    if (status === "failed") {
      const isNewFailure = currentJob.status !== "failed";

      if (isNewFailure) {
        // Strip status/error/completedAt from extraJobUpdate — the helper sets those
        const { status: _s, error: _e, completedAt: _c, ...extraJobUpdate } = updateData;

        const failResult = await markJobFailed({
          jobId: String(req.params.id),
          error: errorMsg ? String(errorMsg).slice(0, 2000) : "Job manually marked as failed",
          source: "download-job",
          expectedStatus: currentJob.status,
          extraJobUpdate,
        });

        if (!failResult.changed) {
          res.status(409).json({ error: "Status wurde zwischenzeitlich geändert (Konflikt)." });
          return;
        }
      } else {
        // Same-status update — just update fields, no counter change
        const casResult = await prisma.downloadJob.updateMany({
          where: { id: String(req.params.id), status: "failed" },
          data: updateData,
        });

        if (casResult.count === 0) {
          res.status(409).json({ error: "Status wurde zwischenzeitlich geändert (Konflikt)." });
          return;
        }
      }

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

    // Non-completed/non-failed status: compare-and-swap update
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
import { parseUsenetServersFromEnv } from "../lib/usenet-config.js";
import { addMapping, removeMapping } from "../lib/caddy-mapping.js";

// GET /downloads/jobs/:id/link — generate presigned download URL for a completed job
router.get("/jobs/:id/link", async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: {
        nzbFile: {
          include: { movie: { select: { id: true, tmdbId: true, titleDe: true, titleEn: true, year: true, posterPath: true } } },
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

    const { isS3Configured, generatePresignedUrl, getFileMetadata, EXPIRY_PRESETS, MAX_PRESIGNED_EXPIRY_SECONDS } = await import("../lib/s3.js");

    if (!isS3Configured()) {
      res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
      return;
    }

    // Verify file actually exists in S3 before generating a presigned URL
    // Use the persisted bucket — not the default — in case S3_BUCKET changed.
    try {
      await getFileMetadata(job.nzbFile.s3Key, job.nzbFile.s3Bucket || undefined);
    } catch (s3Err: any) {
      const statusCode = s3Err?.$metadata?.httpStatusCode || s3Err?.name;
      if (statusCode === 404 || statusCode === "NotFound" || s3Err?.name === "NotFound") {
        // File genuinely gone — reset NzbFile S3 fields and mark job as failed
        // so subsequent requests get a consistent 410 instead of a confusing 422.
        await prisma.$transaction([
          prisma.nzbFile.update({
            where: { id: job.nzbFile.id },
            data: { s3Key: null, s3Bucket: null, fileExtension: null, downloadedAt: null },
          }),
          prisma.downloadJob.update({
            where: { id: job.id },
            data: { status: "failed", error: "S3-Datei nicht mehr vorhanden", completedAt: new Date() },
          }),
        ]);
        console.warn(`[download-job] S3 file missing for ${job.nzbFile.hash.slice(0, 12)}... — DB reset, job failed`);
        res.status(410).json({
          error: "Datei ist nicht mehr verfügbar. Bitte erneut herunterladen.",
          code: "FILE_GONE",
        });
      } else {
        // Transient error (timeout, 5xx, auth) — don't touch DB
        console.error(`[download-job] S3 HEAD failed for ${job.nzbFile.hash.slice(0, 12)}...:`, s3Err?.message || s3Err);
        res.status(502).json({ error: "S3-Verbindung fehlgeschlagen. Bitte erneut versuchen." });
      }
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

// POST /downloads/jobs/:id/assign-movie — link a needs_review job to a TMDB movie
//
// Transitions the job (and all sibling jobs on the same NzbFile) from
// needs_review → queued, then triggers the auto-provisioner in the background.
//
// Body: { tmdbId: number }
//
// Ownership: only the original uploader (job.userId === caller.userId) may assign.
// Service tokens with null userId can only assign jobs that were themselves
// created with null userId (so an admin token cannot hijack a user's job).
router.post("/jobs/:id/assign-movie", async (req: AuthRequest, res: Response) => {
  try {
    const { tmdbId } = req.body ?? {};

    // Validate tmdbId
    if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) {
      res.status(400).json({ error: "tmdbId ist erforderlich (positive ganze Zahl)." });
      return;
    }

    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: { nzbFile: true },
    });

    if (!job) {
      res.status(404).json({ error: "Download-Job nicht gefunden." });
      return;
    }

    // Ownership check: caller must be the job's uploader
    const callerId = req.user?.userId ?? null;
    if (job.userId !== callerId) {
      res.status(403).json({ error: "Nur der Uploader kann diesem Job einen Film zuordnen." });
      return;
    }

    // Status check: only needs_review jobs can be assigned
    if (job.status !== "needs_review") {
      res.status(409).json({
        error: `Nur Jobs im Status 'needs_review' können zugeordnet werden (aktuell: ${job.status}).`,
        currentStatus: job.status,
      });
      return;
    }

    // --- TMDB lookup (outside transaction — I/O) ---
    const tmdbResult = await searchTmdbMovieById(tmdbId);

    if (tmdbResult.status === "disabled") {
      res.status(503).json({
        error: "TMDB-Matching ist nicht verfügbar — Server-Konfiguration fehlt.",
        reason: "tmdb_disabled",
      });
      return;
    }

    if (tmdbResult.status === "error") {
      res.status(503).json({
        error: "TMDB-Lookup fehlgeschlagen. Bitte später erneut versuchen.",
        reason: tmdbResult.reason,
      });
      return;
    }

    if (tmdbResult.status === "not_found") {
      res.status(404).json({
        error: `TMDB-Film mit ID ${tmdbId} nicht gefunden.`,
        tmdbId,
      });
      return;
    }

    const tmdb = tmdbResult.movie;

    // --- Atomic assignment inside a transaction ---
    // Handles three races:
    //  1. NzbFile already got a movieId (another user assigned in parallel or
    //     the reconciler auto-assigned) → we respect that, flip only our own job.
    //  2. NzbMovie with this tmdbId already exists → reuse it.
    //  3. Two concurrent assigns create the same tmdbId → P2002 unique error,
    //     we re-read the winner.
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Fresh read of the NzbFile — movieId may have been set under us.
        const freshFile = await tx.nzbFile.findUnique({
          where: { id: job.nzbFileId },
          select: { id: true, movieId: true, hash: true },
        });

        if (!freshFile) {
          return { outcome: "file_missing" as const };
        }

        // Race: NzbFile was already assigned to a movie by someone else.
        // Flip only our own job and report alreadyAssigned.
        if (freshFile.movieId !== null) {
          const existingMovie = await tx.nzbMovie.findUniqueOrThrow({
            where: { id: freshFile.movieId },
          });

          // Flip our own job (CAS on status)
          const cas = await tx.downloadJob.updateMany({
            where: { id: job.id, status: "needs_review" },
            data: {
              status: "queued",
              error: null,
              reviewExpiresAt: null,
              tmdbRetryAfter: null,
            },
          });

          return {
            outcome: "already_assigned" as const,
            movie: existingMovie,
            flippedJobIds: cas.count > 0 ? [job.id] : [],
          };
        }

        // Reuse-or-create the NzbMovie on the tmdbId unique constraint.
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
              // Race: another request created the same tmdbId concurrently.
              movie = await tx.nzbMovie.findUniqueOrThrow({ where: { tmdbId: tmdb.tmdbId } });
            } else {
              throw err;
            }
          }
        }

        // Link NzbFile → movie
        await tx.nzbFile.update({
          where: { id: freshFile.id },
          data: { movieId: movie.id },
        });

        // Flip ALL needs_review jobs on this NzbFile to queued (could be more
        // than one if multiple users uploaded the same hash).
        const flipped = await tx.downloadJob.findMany({
          where: { nzbFileId: freshFile.id, status: "needs_review" },
          select: { id: true },
        });

        await tx.downloadJob.updateMany({
          where: { nzbFileId: freshFile.id, status: "needs_review" },
          data: {
            status: "queued",
            error: null,
            reviewExpiresAt: null,
            tmdbRetryAfter: null,
          },
        });

        return {
          outcome: "assigned" as const,
          movie,
          flippedJobIds: flipped.map((j) => j.id),
        };
      });
    } catch (err: any) {
      if (err?.code === "P2034" || err?.code === "40001") {
        res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
        return;
      }
      throw err;
    }

    if (result.outcome === "file_missing") {
      res.status(404).json({ error: "NZB-Datei wurde inzwischen entfernt." });
      return;
    }

    // Log outcome
    if (result.outcome === "already_assigned") {
      console.log(
        `[assign] Race detected: NzbFile already linked to TMDB ${result.movie.tmdbId} (${result.movie.titleEn}) — flipped only own job ${job.id.slice(0, 8)}...`
      );
    } else {
      console.log(
        `[assign] Linked NzbFile to TMDB ${result.movie.tmdbId} (${result.movie.titleEn}) — flipped ${result.flippedJobIds.length} job(s)`
      );
    }

    // Respond before triggering provisioners
    res.status(200).json({
      movie: {
        id: result.movie.id,
        tmdbId: result.movie.tmdbId,
        imdbId: result.movie.imdbId,
        titleDe: result.movie.titleDe,
        titleEn: result.movie.titleEn,
        year: result.movie.year,
        posterPath: result.movie.posterPath,
      },
      flippedCount: result.flippedJobIds.length,
      alreadyAssigned: result.outcome === "already_assigned",
    });

    // Trigger auto-provisioner for all flipped jobs (background, best-effort).
    // Skipped in test env via AUTO_PROVISION=false.
    if (process.env.AUTO_PROVISION !== "false" && result.flippedJobIds.length > 0) {
      import("../lib/provisioner.js").then(({ provisionDownload }) => {
        for (const flippedId of result.flippedJobIds) {
          provisionDownload(flippedId).catch((err) => {
            console.error(`[assign] Auto-provision failed for job ${flippedId}:`, err);
          });
        }
      }).catch((err) => {
        console.error("[assign] Failed to load provisioner module:", err);
      });
    }
  } catch (err: any) {
    console.error("[assign] Error:", err);
    res.status(500).json({ error: "Fehler beim Zuordnen des Films." });
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
    const requiredEnvVars = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "API_BASE_URL", "NZB_SERVICE_URL"];
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

    // Defensive: a queued job must have a movieId. If something landed a
    // needs_review NzbFile in queued state without going through assign-movie,
    // abort before spinning up a VPS.
    if (!job.nzbFile.movieId || !job.nzbFile.movie) {
      res.status(409).json({
        error: "NZB-Datei wartet auf manuelle Film-Zuordnung.",
        reason: "needs_review",
        hint: "Ordne der NZB einen Film zu, bevor der Download provisioniert werden kann.",
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

    const serverName = `dl-${job.id.slice(0, 8)}`;

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
      usenetServers: parseUsenetServersFromEnv(),
      dockerImage: process.env.DOWNLOADER_DOCKER_IMAGE || "ghcr.io/ichbinder/openmedia-downloader:latest",
      serverName,
    });

    const rawNetworkId = process.env.HETZNER_NETWORK_ID;
    const networkId = rawNetworkId ? parseInt(rawNetworkId, 10) : undefined;
    if (rawNetworkId && (!networkId || isNaN(networkId))) {
      console.warn(`[download-vps] HETZNER_NETWORK_ID is not a valid number: "${rawNetworkId}"`);
    }

    let result;
    try {
      result = await createServer({
        name: serverName,
        userData: cloudInit,
        sshKeys: process.env.HETZNER_SSH_KEY_NAME ? [process.env.HETZNER_SSH_KEY_NAME] : undefined,
        labels: { "job-id": job.id },
        networks: networkId ? [networkId] : undefined,
      });
    } catch (err: any) {
      // Rollback job status on server creation failure
      await prisma.downloadJob.update({
        where: { id: job.id },
        data: { status: "failed", error: `VPS-Erstellung fehlgeschlagen: ${err.message}`, completedAt: new Date() },
      });
      throw err;
    }

    // Update job with server info (prefer private IP for internal routing)
    await prisma.downloadJob.update({
      where: { id: job.id },
      data: {
        hetznerServerId: result.server.id,
        hetznerServerIp: result.server.privateIp || result.server.publicIpv4,
      },
    });

    // Register Caddy reverse proxy mapping for SABnzbd UI access
    if (result.server.privateIp) {
      try {
        await addMapping(serverName, result.server.privateIp);
      } catch (mappingErr: any) {
        console.error(`[download-vps] Caddy mapping failed (non-fatal): ${mappingErr.message}`);
      }
    }

    console.log(`[download-vps] Provisioned: ${serverName} (id: ${result.server.id}, private: ${result.server.privateIp}) for job ${job.id}`);

    res.status(201).json({
      server: {
        id: result.server.id,
        name: result.server.name,
        status: result.server.status,
        ip: result.server.publicIpv4,
        privateIp: result.server.privateIp,
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

    const serverName = `dl-${job.id.slice(0, 8)}`;
    const deleted = await deleteServer(job.hetznerServerId);

    // Remove Caddy reverse proxy mapping
    try {
      await removeMapping(serverName);
    } catch (mappingErr: any) {
      console.error(`[download-vps] Caddy mapping removal failed (non-fatal): ${mappingErr.message}`);
    }

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

    // Delete zombies and clean up Caddy mappings
    const deletedIds: number[] = [];
    for (const server of zombies) {
      try {
        const deleted = await deleteServer(server.id);
        if (deleted) {
          deletedIds.push(server.id);
          try {
            await removeMapping(server.name);
          } catch {
            // Best-effort — mapping may not exist
          }
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

// ---------------------------------------------------------------------------
// Job Reconciliation (manual trigger)
// ---------------------------------------------------------------------------

import { reconcileStaleJobs } from "../lib/job-reconciler.js";

// POST /downloads/reconcile — manually trigger stale job detection
router.post("/reconcile", async (_req: AuthRequest, res: Response) => {
  try {
    const result = await reconcileStaleJobs();
    res.json(result);
  } catch (err: any) {
    console.error("[download] Reconcile error:", err.message);
    res.status(500).json({ error: "Fehler bei der Job-Bereinigung." });
  }
});

export default router;
