import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, requireServiceOrUserAuth, type AuthRequest } from "../middleware/auth.js";
import { parseNzbName } from "../lib/nzb-parser.js";
import { sendToSabnzbd, getSabnzbdStatus, getSabnzbdConfigSummary } from "../lib/sabnzbd.js";
import { searchTmdbMovie, searchTmdbMovieById, type TmdbMovieResult } from "../lib/tmdb.js";
import { markJobFailed } from "../lib/job-failure.js";
import { getDownloadVpsConfig, getUploadVpsConfig } from "../lib/vps-config.js";
import { generateServiceToken, storeServiceToken, deleteServiceTokens } from "../lib/service-token.js";
import { drainQueue } from "../lib/queue-drain.js";
import { resolveEpisodeFromTmdb } from "../lib/episode-resolver.js";
import { ingestNzb, JOB_NZB_FILE_INCLUDE } from "../lib/nzb-ingest.js";
import { isSerializationFailure, startDownloadJob } from "../lib/download-jobs.js";

const router = Router();

// No global auth — applied per-route:
// - VPS callback routes use requireServiceOrUserAuth (JWT or service token)
// - All other routes use requireAuth (JWT only)

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
router.get("/sabnzbd/status", requireAuth, async (_req: AuthRequest, res: Response) => {
  const status = await getSabnzbdStatus();
  res.json(status);
});

// GET /downloads/sabnzbd/config — check if SABnzbd is configured
router.get("/sabnzbd/config", requireAuth, (_req: AuthRequest, res: Response) => {
  res.json(getSabnzbdConfigSummary());
});

// POST /downloads/start — start a download by sending NZB to SABnzbd (legacy)
router.post("/start", requireAuth, async (req: AuthRequest, res: Response) => {
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
router.post("/jobs", requireAuth, async (req: AuthRequest, res: Response) => {
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
    if (!nzbFile.movieId && !nzbFile.episodeId) {
      res.status(409).json({
        error: "NZB-Datei wartet auf manuelle Film-Zuordnung.",
        reason: "needs_review",
        hint: "Ordne der NZB einen Film zu, bevor ein Download-Job erstellt werden kann.",
      });
      return;
    }

    let result;
    try {
      result = await startDownloadJob(nzbFileId, req.user?.userId || null);
    } catch (err) {
      if (isSerializationFailure(err)) {
        res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
        return;
      }
      throw err;
    }

    if (result.kind === "conflict") {
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
router.post("/request", requireAuth, async (req: AuthRequest, res: Response) => {
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

    const result = await ingestNzb({
      nzbContent,
      title,
      filename,
      userId: req.user?.userId || null,
      resolve: (parsed) =>
        parsed.season !== null && parsed.episode !== null
          ? resolveEpisodeFromTmdb(parsed, title)
          : resolveMovieFromTmdb(parsed.title, parsed.year, title),
    });

    switch (result.kind) {
      case "already-available":
        res.status(200).json({
          alreadyAvailable: true,
          message: "Film ist bereits heruntergeladen und verfügbar.",
          movie: result.file.movie,
          nzbFile: {
            id: result.file.id,
            hash: result.file.hash,
            resolution: result.file.resolution,
            s3Key: result.file.s3Key,
            s3StreamKey: result.file.s3StreamKey,
          },
        });
        return;
      case "broken":
        res.status(410).json({
          error: "Diese NZB-Datei ist als kaputt markiert.",
          reason: result.file.brokenReason || `Download ${result.file.failedAttempts}x fehlgeschlagen.`,
          failedAttempts: result.file.failedAttempts,
          movie: result.file.movie,
          hint: "Bitte suche eine andere NZB-Version dieses Films.",
        });
        return;
      case "service-unavailable":
        res.status(503).json({
          error: "NZB-Service nicht erreichbar — Download abgebrochen.",
          reason: "nzb_service_unavailable",
        });
        return;
      case "concurrent":
        res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
        return;
      case "missing":
        res.status(404).json({ error: "NZB-Datei wurde inzwischen entfernt." });
        return;
      case "conflict":
        res.status(409).json({
          error: "Es läuft bereits ein Download für diese Datei.",
          existingJobId: result.activeJob.id,
          existingStatus: result.activeJob.status,
        });
        return;
      case "tmdb-disabled":
        res.status(503).json({
          error: "TMDB-Matching ist nicht verfügbar — Server-Konfiguration fehlt.",
          reason: "tmdb_disabled",
          hint: "Der Administrator muss TMDB_API_KEY setzen.",
        });
        return;
      case "reload-failed":
        res.status(500).json({ error: "Job wurde erstellt, konnte aber nicht geladen werden." });
        return;
      case "created":
        res.status(201).json({
          job: serializeJob(result.job),
          reused: result.reused,
          needsReview: result.needsReview,
        });
        return;
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
router.get("/jobs", requireAuth, async (req: AuthRequest, res: Response) => {
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
          include: {
            movie: { select: { id: true, tmdbId: true, titleDe: true, titleEn: true, year: true, posterPath: true } },
            episode: JOB_NZB_FILE_INCLUDE.episode,
          },
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
router.get("/jobs/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.downloadJob.findUnique({
      where: { id: String(req.params.id) },
      include: { nzbFile: { include: JOB_NZB_FILE_INCLUDE } },
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
// Accepts both JWT and service tokens (VPS sends service tokens for callbacks).
router.patch("/jobs/:id/status", requireServiceOrUserAuth, async (req: AuthRequest, res: Response) => {
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
                select: { source: true, s3Key: true, hash: true, movieId: true, episodeId: true },
              });
              if (!nzb || nzb.source === "own" || !nzb.s3Key) return null;

              // Check: does this Movie/Episode already have a healthy own version?
              // Expired/broken own versions don't count — their Usenet content is unavailable
              const ownTarget = nzb.movieId
                ? { movieId: nzb.movieId }
                : nzb.episodeId
                  ? { episodeId: nzb.episodeId }
                  : null;
              if (ownTarget) {
                const ownVersion = await tx.nzbFile.findFirst({
                  where: {
                    ...ownTarget,
                    source: "own",
                    status: { notIn: ["expired", "broken"] },
                  },
                  select: { id: true },
                });
                if (ownVersion) return null;
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
                  episodeId: nzb.episodeId,
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
                    const { plaintext: serviceToken, hash: tokenHash } = generateServiceToken();
                    await storeServiceToken(tokenHash, uploadJob.id, "upload");

                    const serverName = `up-${nzbForProvision.hash.substring(0, 8)}`;
                    const result = await provisionUploadVps({
                      jobId: uploadJob.id,
                      nzbFileHash: nzbForProvision.hash,
                      apiBaseUrl: uploadConfig.apiBaseUrl,
                      serviceToken,
                      dockerImage: uploadConfig.dockerImage,
                      serverName,
                    });
                    await prisma.uploadJob.update({
                      where: { id: uploadJob.id },
                      data: {
                        status: "running",
                        hetznerServerId: result.server.id,
                        hetznerServerIp: result.server.privateIp || result.server.publicIpv4,
                        startedAt: new Date(),
                      },
                    });
                    console.log(`[auto-upload] Upload VPS provisioned: ${result.server.name} (id=${result.server.id}, ip=${result.server.privateIp || result.server.publicIpv4})`);
                  } catch (provErr) {
                    deleteServiceTokens(uploadJob.id).catch(() => {});
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
router.delete("/jobs/:id", requireAuth, async (req: AuthRequest, res: Response) => {
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

    if (job.userId) {
      await prisma.movieRequest.updateMany({
        where: { nzbFileId: job.nzbFileId, userId: job.userId, status: "downloading" },
        data: { status: "failed", failReason: "cancelled" },
      });
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
import { addMapping, removeMapping } from "../lib/caddy-mapping.js";

// GET /downloads/jobs/:id/link — generate presigned download URL for a completed job
router.get("/jobs/:id/link", requireAuth, async (req: AuthRequest, res: Response) => {
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
    const url = await generatePresignedUrl(job.nzbFile.s3Key, cappedExpires, {
      bucket: job.nzbFile.s3Bucket || undefined,
    });
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
router.post("/jobs/:id/assign-movie", requireAuth, async (req: AuthRequest, res: Response) => {
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

    if (parseNzbName(job.nzbFile.originalFilename).season !== null) {
      res.status(409).json({
        error: "Folgen werden automatisch zugeordnet und können nicht als Film zugewiesen werden.",
        reason: "episode_not_assignable",
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
router.post("/jobs/:id/provision", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
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

    if (!isHetznerConfigured()) {
      res.status(503).json({ error: "Hetzner Cloud API ist nicht konfiguriert." });
      return;
    }

    // Resolve config from DB config store (K050: use centralized getDownloadVpsConfig)
    const dlConfig = await getDownloadVpsConfig();
    if (!dlConfig) {
      res.status(503).json({ error: "Download-VPS-Konfiguration nicht verfügbar (DB config store)." });
      return;
    }

    // Defensive: a queued job must have a movieId or episodeId. If something landed a
    // needs_review NzbFile in queued state without going through assign-movie,
    // abort before spinning up a VPS.
    if (!job.nzbFile.movieId && !job.nzbFile.episodeId) {
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

    const serverName = `dl-${job.id.slice(0, 8)}`;

    // Generate per-VPS service token
    const { generateServiceToken, storeServiceToken, deleteServiceTokens } = await import("../lib/service-token.js");
    const { plaintext: serviceTokenPlaintext, hash: serviceTokenHash } = generateServiceToken();
    await storeServiceToken(serviceTokenHash, job.id, "download");
    console.log(`[download-vps] ServiceToken created for job ${job.id}`);

    const cloudInit = generateCloudInit({
      jobId: job.id,
      apiBaseUrl: dlConfig.apiBaseUrl,
      serviceToken: serviceTokenPlaintext,
      dockerImage: dlConfig.dockerImage,
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
      // Clean up orphaned ServiceToken — VPS was never created
      try {
        await deleteServiceTokens(job.id);
      } catch (_) { /* best-effort cleanup */ }

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
// Accepts both JWT and service tokens (VPS sends service tokens for callbacks).
router.post("/jobs/:id/cleanup", requireServiceOrUserAuth, async (req: AuthRequest, res: Response) => {
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

    // Delete service tokens for this job (non-fatal)
    try {
      await deleteServiceTokens(job.id);
    } catch (tokenErr: any) {
      console.error(`[download-vps] Token cleanup failed (non-fatal): ${tokenErr.message}`);
    }

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

    // Slot freed — try to provision next queued job
    drainQueue().catch((err) => console.error("[download-vps] Queue drain failed:", err.message));

    res.json({ success: true, deleted, serverId: job.hetznerServerId });
  } catch (err: any) {
    console.error("[download-vps] Cleanup error:", err.message);
    res.status(500).json({ error: `Fehler beim Löschen des Download-Servers: ${err.message}` });
  }
});

// GET /downloads/servers — list active download servers
router.get("/servers", requireAuth, async (_req: AuthRequest, res: Response) => {
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
router.post("/cleanup-zombies", requireAuth, async (req: AuthRequest, res: Response) => {
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
router.post("/reconcile", requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await reconcileStaleJobs();
    res.json(result);
  } catch (err: any) {
    console.error("[download] Reconcile error:", err.message);
    res.status(500).json({ error: "Fehler bei der Job-Bereinigung." });
  }
});

export default router;
