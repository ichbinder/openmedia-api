import { createHash } from "crypto";
import { Router, type Response } from "express";
import prisma from "../lib/prisma.js";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { parseNzbName } from "../lib/nzb-parser.js";
import { sendToSabnzbd, getSabnzbdStatus, getSabnzbdConfigSummary } from "../lib/sabnzbd.js";
import { searchTmdbMovie, type TmdbMovieResult } from "../lib/tmdb.js";
import { markJobFailed } from "../lib/job-failure.js";

const router = Router();

router.use(requireAuth);

/**
 * Resolve a movie via TMDB lookup or fallback.
 *
 * Two cases:
 * 1. TMDB found → return TMDB data; reuse vs create is decided inside the
 *    transaction to avoid a TOCTOU race on the tmdbId unique constraint.
 * 2. TMDB not found / error → return fallback data with user-supplied title.
 */
async function resolveMovieFromTmdb(
  parsedTitle: string,
  parsedYear: number | null,
  fallbackTitle: string,
): Promise<
  | { source: "tmdb-found"; tmdb: TmdbMovieResult }
  | { source: "fallback"; titleDe: string; titleEn: string; year: number | null }
> {
  // Use parsed title if available, fallback to user-supplied title
  const searchTitle = parsedTitle || fallbackTitle;

  if (!searchTitle) {
    return { source: "fallback", titleDe: fallbackTitle, titleEn: fallbackTitle, year: parsedYear };
  }

  const result = await searchTmdbMovie(searchTitle, parsedYear);

  if (result.status === "error") {
    console.warn(
      `[matching] TMDB error for "${searchTitle}" (${parsedYear || "?"}): ${result.reason} — using fallback`
    );
    return { source: "fallback", titleDe: fallbackTitle, titleEn: fallbackTitle, year: parsedYear };
  }

  if (result.status === "not_found") {
    console.log(
      `[matching] No TMDB match for "${searchTitle}" (${parsedYear || "?"}) — using fallback`
    );
    return { source: "fallback", titleDe: fallbackTitle, titleEn: fallbackTitle, year: parsedYear };
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

const VALID_STATUSES = ["queued", "provisioning", "downloading", "uploading", "completed", "failed"] as const;
type JobStatus = (typeof VALID_STATUSES)[number];

/** Map of allowed status transitions: current → allowed next statuses */
const STATUS_TRANSITIONS: Record<string, JobStatus[]> = {
  queued: ["provisioning", "failed"],
  provisioning: ["downloading", "failed"],
  downloading: ["uploading", "failed"],
  uploading: ["completed", "failed"],
  // Terminal states — no transitions out
  completed: [],
  failed: [],
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

    console.log(`[download-job] Created: ${result.job.id} for ${nzbFile.movie.titleEn} (${nzbFile.hash.slice(0, 12)}...)`);

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
// NZB Storage helper — forward NZB content to the NZB service
// ---------------------------------------------------------------------------

/**
 * Store NZB content in the NZB service (nzb.nettoken.de).
 * Non-blocking: logs a warning on failure but does not throw.
 */
async function storeNzbInService(hash: string, nzbContent: string): Promise<boolean> {
  const serviceToken = process.env.SERVICE_API_TOKEN;

  if (!serviceToken) {
    console.warn(`[nzb-request] SERVICE_API_TOKEN not set — skipping NZB storage`);
    return false;
  }

  try {
    // Check if file already exists (HEAD request)
    const headRes = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (headRes.ok) {
      console.log(`[nzb-request] NZB ${hash.slice(0, 12)}... already exists on NZB service — skipping upload`);
      return true;
    }

    // Upload the NZB content
    const putRes = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/x-nzb",
      },
      body: nzbContent,
      signal: AbortSignal.timeout(30_000),
    });

    if (putRes.ok) {
      const data = await putRes.json() as { size?: number };
      console.log(`[nzb-request] Stored NZB ${hash.slice(0, 12)}... on NZB service (${data.size ?? "?"} bytes)`);
      return true;
    }

    const errorText = await putRes.text().catch(() => "");
    console.error(`[nzb-request] NZB service PUT failed: HTTP ${putRes.status} — ${errorText}`);
    return false;
  } catch (err: any) {
    console.error(`[nzb-request] NZB service unreachable: ${err.message}`);
    return false;
  }
}

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

      // File already known — atomic check-and-create inside a transaction
      let reuseResult;
      try {
        reuseResult = await prisma.$transaction(async (tx) => {
          const activeJob = await tx.downloadJob.findFirst({
            where: {
              nzbFileId: existingFile.id,
              status: { in: ["queued", "provisioning", "downloading", "uploading"] },
            },
          });

          if (activeJob) {
            return { conflict: true as const, activeJob };
          }

          const job = await tx.downloadJob.create({
            data: { nzbFileId: existingFile.id, userId: req.user?.userId || null },
            include: { nzbFile: { include: { movie: true } } },
          });

          return { conflict: false as const, job };
        }, { isolationLevel: "Serializable" });
      } catch (err: any) {
        if (err?.code === "P2034" || err?.code === "40001") {
          res.status(409).json({ error: "Gleichzeitiger Request — bitte erneut versuchen." });
          return;
        }
        throw err;
      }

      if (reuseResult.conflict) {
        res.status(409).json({
          error: "Es läuft bereits ein Download für diese Datei.",
          existingJobId: reuseResult.activeJob.id,
          existingStatus: reuseResult.activeJob.status,
        });
        return;
      }

      console.log(`[nzb-request] Reusing existing NzbFile ${hash.slice(0, 12)}... → new job ${reuseResult.job.id}`);

      // Ensure NZB exists on NZB service (may have been imported without it)
      storeNzbInService(hash, nzbContent).catch((err) => {
        console.error(`[nzb-request] Unexpected error storing NZB: ${err}`);
      });

      res.status(201).json({ job: serializeJob(reuseResult.job), reused: true });

      // Trigger auto-provisioner
      if (process.env.AUTO_PROVISION !== "false") {
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

    // --- Resolve movie via TMDB (with fallback) ---
    const movieResolution = await resolveMovieFromTmdb(parsed.title, parsed.year, title);

    // --- Create NzbMovie (or reuse existing) + NzbFile + DownloadJob in one transaction ---
    const result = await prisma.$transaction(async (tx) => {
      let movieId: string;
      let movie;

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
      } else {
        // Fallback — no TMDB data available
        movie = await tx.nzbMovie.create({
          data: {
            titleDe: movieResolution.titleDe,
            titleEn: movieResolution.titleEn,
            year: movieResolution.year,
          },
        });
        movieId = movie.id;
      }

      const nzbFile = await tx.nzbFile.create({
        data: {
          movieId,
          hash,
          originalFilename: effectiveFilename,
          fileSize: BigInt(Buffer.byteLength(nzbContent, "utf-8")),
          resolution: parsed.resolution,
          audioLanguages: parsed.audioLanguages,
          codec: parsed.codec,
          source: parsed.source,
        },
      });

      const job = await tx.downloadJob.create({
        data: {
          nzbFileId: nzbFile.id,
          userId: req.user?.userId || null,
        },
      });

      return { movie, nzbFile, job };
    });

    console.log(
      `[nzb-request] Created: movie=${result.movie.id} file=${result.nzbFile.id} job=${result.job.id} ` +
      `"${title}" (${parsed.resolution || "unknown"})`
    );

    // --- Store NZB in NZB service (non-blocking) ---
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

    res.status(201).json({ job: serializeJob(fullJob), reused: false });

    // Trigger auto-provisioner
    if (process.env.AUTO_PROVISION !== "false") {
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
