import { createHash } from "crypto";
import type { DownloadJob, NzbFile, NzbMovie, Prisma } from "../../generated/client/index.js";
import prisma from "./prisma.js";
import { parseNzbName, type ParsedNzbName } from "./nzb-parser.js";
import type { TmdbMovieResult, TmdbShowResult, TmdbEpisodeResult } from "./tmdb.js";
import { computeReviewExpiresAt, computeInitialTmdbRetryAfter } from "./review-config.js";
import { storeNzbInService, NzbServiceUnavailableError } from "./nzb-service.js";
import { upsertEpisode } from "./episode-resolver.js";

export const JOB_NZB_FILE_INCLUDE = {
  movie: true,
  episode: {
    select: {
      id: true,
      season: true,
      episode: true,
      titleDe: true,
      show: { select: { tmdbId: true, titleDe: true, titleEn: true, year: true, posterPath: true } },
    },
  },
} as const;

export type IngestResolution =
  | { source: "tmdb-found"; tmdb: TmdbMovieResult }
  | { source: "tmdb-found"; show: TmdbShowResult; season: number; episode: number; tmdbEpisode: TmdbEpisodeResult | null }
  | { source: "needs-review"; reason: "not-found" | "error"; errorDetail?: string }
  | { source: "tmdb-disabled"; reason: string };

export interface IngestInput {
  nzbContent: string;
  title: string;
  filename?: string;
  userId: string | null;
  resolve: (parsed: ParsedNzbName) => Promise<IngestResolution>;
  fileData?: {
    indexerGuid: string;
    qualityTier: string;
    resolution: string;
    fileSize: bigint;
    audioLanguages: string[];
    subtitleLanguages: string[];
    releaseType: string | null;
  };
}

type FileWithMovie = NzbFile & { movie: NzbMovie | null };
type JobWithNzbFile = Prisma.DownloadJobGetPayload<{ include: { nzbFile: { include: typeof JOB_NZB_FILE_INCLUDE } } }>;

/**
 * Throws Prisma P2002 when a concurrent request created the same hash; callers
 * map that themselves.
 */
export type IngestResult =
  | { kind: "already-available"; file: FileWithMovie }
  | { kind: "broken"; file: FileWithMovie }
  | { kind: "conflict"; activeJob: DownloadJob }
  | { kind: "missing" }
  | { kind: "concurrent" }
  | { kind: "service-unavailable" }
  | { kind: "tmdb-disabled" }
  | { kind: "reload-failed" }
  | { kind: "created"; job: JobWithNzbFile; reused: boolean; needsReview: boolean };

function triggerProvision(jobId: string) {
  if (process.env.AUTO_PROVISION === "false") return;
  import("./provisioner.js").then(({ provisionDownload }) => {
    provisionDownload(jobId).catch((err) => {
      console.error("[nzb-request] Auto-provision failed:", err);
    });
  }).catch((err) => {
    console.error("[nzb-request] Failed to load provisioner module:", err);
  });
}

async function storeOrUnavailable(hash: string, nzbContent: string): Promise<boolean> {
  try {
    await storeNzbInService(hash, nzbContent);
    return true;
  } catch (err) {
    if (err instanceof NzbServiceUnavailableError) return false;
    throw err;
  }
}

export async function ingestNzb(input: IngestInput): Promise<IngestResult> {
  const { nzbContent, title, filename, userId, resolve, fileData } = input;

  const hash = createHash("sha256").update(nzbContent).digest("hex");
  console.log(`[nzb-request] Processing: "${title}" (hash: ${hash.slice(0, 12)}...)`);

  const existingFile = await prisma.nzbFile.findUnique({
    where: { hash },
    include: { movie: true },
  });

  if (existingFile) {
    if (fileData && !existingFile.indexerGuid) {
      await prisma.nzbFile.updateMany({
        where: { id: existingFile.id, indexerGuid: null },
        data: { indexerGuid: fileData.indexerGuid },
      });
    }

    // If the file is already on S3, broken status is irrelevant — the user can
    // still stream it. So we check S3 first.
    if (existingFile.s3Key) {
      try {
        const { fileExists } = await import("./s3.js");
        const onS3 = await fileExists(existingFile.s3Key, existingFile.s3Bucket || undefined);

        if (onS3) {
          console.log(
            `[nzb-request] Already on S3: ${hash.slice(0, 12)}... → ${existingFile.s3Key} — skipping download`
          );
          return { kind: "already-available", file: existingFile };
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
        console.warn(`[nzb-request] S3 check failed: ${err.message} — continuing with download`);
      }
    }

    if (existingFile.status === "broken") {
      console.log(
        `[nzb-request] Rejected broken NZB: ${hash.slice(0, 12)}... (${existingFile.failedAttempts} failures)`
      );
      return { kind: "broken", file: existingFile };
    }

    // Store BEFORE creating DB rows so a down NZB service never leaves an
    // orphan DownloadJob pointing at an NZB the VPS can't fetch.
    if (!(await storeOrUnavailable(hash, nzbContent))) return { kind: "service-unavailable" };

    // movieId/episodeId are re-read INSIDE the transaction so a concurrent
    // assign-movie can't make us decide needs_review on a stale null.
    let reuseResult;
    try {
      reuseResult = await prisma.$transaction(async (tx) => {
        const freshFile = await tx.nzbFile.findUnique({
          where: { id: existingFile.id },
          select: { id: true, movieId: true, episodeId: true },
        });

        if (!freshFile) return { kind: "missing" as const };

        const reuseNeedsReview = freshFile.movieId === null && freshFile.episodeId === null;

        // Any active download for this file blocks a new job — the second user
        // shares the result via S3 once the first download finishes.
        const runningJob = await tx.downloadJob.findFirst({
          where: {
            nzbFileId: existingFile.id,
            status: { in: ["queued", "provisioning", "downloading", "uploading"] },
          },
        });

        if (runningJob) return { kind: "conflict" as const, activeJob: runningJob };

        // Per-user: surface this user's pending review instead of a duplicate.
        // Other users may have their own review jobs in parallel — intentional.
        const ownReview = await tx.downloadJob.findFirst({
          where: {
            nzbFileId: existingFile.id,
            status: "needs_review",
            userId,
          },
        });

        if (ownReview) return { kind: "conflict" as const, activeJob: ownReview };

        const job = await tx.downloadJob.create({
          data: {
            nzbFileId: existingFile.id,
            userId,
            // No retry hint: we don't know whether the original upload failed
            // via TMDB error or not_found; the reconciler only retries rows
            // whose tmdbRetryAfter is set.
            ...(reuseNeedsReview && {
              status: "needs_review",
              reviewExpiresAt: computeReviewExpiresAt(),
            }),
          },
          include: { nzbFile: { include: JOB_NZB_FILE_INCLUDE } },
        });

        return { kind: "created" as const, job, reused: true, needsReview: reuseNeedsReview };
      }, { isolationLevel: "Serializable" });
    } catch (err: any) {
      if (err?.code === "P2034" || err?.code === "40001") return { kind: "concurrent" };
      throw err;
    }

    if (reuseResult.kind !== "created") return reuseResult;

    if (reuseResult.needsReview) {
      console.log(
        `[nzb-request] Reuse needs_review NzbFile ${hash.slice(0, 12)}... → new job ${reuseResult.job.id} (needs_review)`
      );
    } else {
      console.log(`[nzb-request] Reusing existing NzbFile ${hash.slice(0, 12)}... → new job ${reuseResult.job.id}`);
      triggerProvision(reuseResult.job.id);
    }
    return reuseResult;
  }

  const effectiveFilename = filename || `${title}.nzb`;
  const parsed = parseNzbName(effectiveFilename);

  const resolution = await resolve(parsed);

  if (resolution.source === "tmdb-disabled") return { kind: "tmdb-disabled" };

  const isNeedsReview = resolution.source === "needs-review";

  if (!(await storeOrUnavailable(hash, nzbContent))) return { kind: "service-unavailable" };

  // needs-review: no NzbMovie, NzbFile with movieId=null, job waits in
  // status='needs_review' for manual assignment and is not provisioned.
  const result = await prisma.$transaction(async (tx) => {
    let movieId: string | null = null;
    let movie: { id: string; titleEn: string } | null = null;
    let episodeId: string | null = null;

    if (resolution.source === "tmdb-found" && "show" in resolution) {
      episodeId = await upsertEpisode(tx, resolution.show, resolution.season, resolution.episode, resolution.tmdbEpisode);
    } else if (resolution.source === "tmdb-found") {
      // Reuse-or-create on the tmdbId unique constraint; P2002 means another
      // request won the race between findUnique and create.
      const t = resolution.tmdb;
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

    const nzbFile = await tx.nzbFile.create({
      data: {
        movieId,
        episodeId,
        hash,
        originalFilename: effectiveFilename,
        codec: parsed.codec,
        source: "external",
        ...(fileData ?? {
          fileSize: BigInt(Buffer.byteLength(nzbContent, "utf-8")),
          resolution: parsed.resolution,
          audioLanguages: parsed.audioLanguages,
          releaseType: parsed.source || null,
        }),
      },
    });

    const job = await tx.downloadJob.create({
      data: {
        nzbFileId: nzbFile.id,
        userId,
        // Background retry only for transient TMDB errors; 'not-found' is
        // definitive and needs the user.
        ...(isNeedsReview && {
          status: "needs_review",
          reviewExpiresAt: computeReviewExpiresAt(),
          ...(resolution.reason === "error" && {
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

  const fullJob = await prisma.downloadJob.findUnique({
    where: { id: result.job.id },
    include: { nzbFile: { include: JOB_NZB_FILE_INCLUDE } },
  });

  if (!fullJob) return { kind: "reload-failed" };

  if (!isNeedsReview) triggerProvision(result.job.id);
  return { kind: "created", job: fullJob, reused: false, needsReview: isNeedsReview };
}
