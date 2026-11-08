import { createHash } from "crypto";
import { Prisma, type MovieRequest } from "../../generated/client/index.js";
import prisma from "./prisma.js";
import { searchTmdbMovieById, type TmdbMovieResult } from "./tmdb.js";
import { BUDGET_RESERVE, downloadNzb, getDownloadBudget, IndexerError, searchMovie, withBudgetLock } from "./treasure-maps.js";
import { getTargetBand } from "./release-ranking.js";
import { ingestNzb, type IngestResult } from "./nzb-ingest.js";
import { GROUP_RANK, rankMovieCandidates, type CandidateGroup, type MovieCandidate } from "./movie-ranking.js";
import { isSerializationFailure, startDownloadJob } from "./download-jobs.js";
import { ACTIVE_JOB_STATUSES, addToLibrary, STALE_SEARCH_MS, SYNC_BATCH, TmdbUnavailableError } from "./episode-requests.js";
import { toLanguageCodes } from "./nzb-parser.js";

export const MAX_ATTEMPTS = 3;
export const DEFAULT_MOVIE_RUNTIME_MINUTES = 110;

export type RequestOutcome =
  | { status: "ready"; nzbFileId: string }
  | { status: "downloading"; nzbFileId: string }
  | { status: "confirm_required"; group: "foreign" | "cam" }
  | { status: "budget" }
  | { status: "candidate_gone" }
  | { status: "service_unavailable" }
  | { status: "failed" };

export async function listMovieCandidates(
  tmdbId: number,
): Promise<{ candidates: MovieCandidate[]; indexer: "ok" | "unavailable" }> {
  const [movie, tmdb, band, search] = await Promise.all([
    prisma.nzbMovie.findUnique({ where: { tmdbId }, include: { nzbFiles: true } }),
    searchTmdbMovieById(tmdbId),
    getTargetBand(),
    searchMovie(tmdbId).then(
      (releases) => ({ releases, indexer: "ok" as const }),
      (err) => {
        if (!(err instanceof IndexerError)) throw err;
        console.warn(`[movie-requests] Indexer search for film ${tmdbId} failed: ${err.message}`);
        return { releases: [], indexer: "unavailable" as const };
      },
    ),
  ]);

  const broken = await prisma.nzbFile.findMany({
    where: { status: "broken", indexerGuid: { in: search.releases.map((r) => r.guid) } },
    select: { indexerGuid: true },
  });
  const brokenGuids = new Set(broken.map((f) => f.indexerGuid));
  const runtimeMinutes = (tmdb.status === "found" && tmdb.movie.runtime) || DEFAULT_MOVIE_RUNTIME_MINUTES;
  const candidates = rankMovieCandidates(
    search.releases.filter((r) => !brokenGuids.has(r.guid) && Number.isSafeInteger(r.size)),
    movie?.nzbFiles ?? [],
    { runtimeMinutes, band },
  );
  return { candidates, indexer: search.indexer };
}

function speaksGerman(c: MovieCandidate): boolean {
  return c.group === "german" || (c.group === "cam" && c.german);
}

function alreadyTried(request: MovieRequest, c: MovieCandidate): boolean {
  return (
    request.triedKeys.includes(c.key) ||
    request.triedKeys.includes(`guid:${c.guid}`) ||
    (request.nzbFileId !== null && c.nzbFileId === request.nzbFileId)
  );
}

function fallbacks(request: MovieRequest, candidates: MovieCandidate[]): MovieCandidate[] {
  if (request.manual) return [];
  const allowed = GROUP_RANK[request.allowedGroup as CandidateGroup];
  return candidates.filter(
    (c) =>
      c.state !== "broken" &&
      !alreadyTried(request, c) &&
      GROUP_RANK[c.group] <= allowed &&
      (!request.germanOnly || speaksGerman(c)),
  );
}

async function loadTmdb(tmdbId: number): Promise<TmdbMovieResult> {
  const result = await searchTmdbMovieById(tmdbId);
  if (result.status === "found") return result.movie;
  throw result.status === "not_found"
    ? new TmdbUnavailableError("error", `movie ${tmdbId} not found`)
    : new TmdbUnavailableError(result.status, result.reason);
}

async function markReady(request: MovieRequest, nzbFileId: string): Promise<RequestOutcome> {
  await addToLibrary(request.userId, nzbFileId);
  await prisma.movieRequest.update({ where: { id: request.id }, data: { status: "done", nzbFileId, failReason: null } });
  return { status: "ready", nzbFileId };
}

async function markDownloading(request: MovieRequest, nzbFileId: string): Promise<RequestOutcome> {
  await prisma.movieRequest.update({
    where: { id: request.id },
    data: { status: "downloading", nzbFileId, failReason: null },
  });
  return { status: "downloading", nzbFileId };
}

function markFailed(request: MovieRequest, failReason: "budget" | "no_candidate" | "download_failed") {
  return prisma.movieRequest.update({ where: { id: request.id }, data: { status: "failed", failReason } });
}

async function ingestCandidate(
  request: MovieRequest,
  candidate: MovieCandidate,
  tmdb: TmdbMovieResult,
): Promise<IngestResult | { kind: "shared"; nzbFileId: string }> {
  const guid = candidate.guid!;
  const nzbContent = await downloadNzb(guid);
  try {
    const result = await ingestNzb({
      nzbContent,
      title: candidate.title,
      filename: `${candidate.title}.nzb`,
      userId: request.userId,
      resolve: async () => ({ source: "tmdb-found", tmdb }),
      fileData: {
        indexerGuid: guid,
        qualityTier: candidate.qualityTier,
        resolution: candidate.qualityTier,
        fileSize: BigInt(candidate.sizeBytes!),
        audioLanguages: candidate.audioLanguages,
        // ponytail: only German subtitles survive ranking; carry the raw list in MovieCandidate if other languages matter.
        subtitleLanguages: candidate.germanSubtitles ? ["de"] : [],
        releaseType: candidate.releaseType,
      },
    });
    if (result.kind !== "concurrent") return result;
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
  }
  const hash = createHash("sha256").update(nzbContent).digest("hex");
  const file = await prisma.nzbFile.findUniqueOrThrow({ where: { hash } });
  return { kind: "shared", nzbFileId: file.id };
}

async function attemptIndexerHit(
  request: MovieRequest,
  candidate: MovieCandidate,
  tmdb: TmdbMovieResult,
): Promise<RequestOutcome | null> {
  const result = await withBudgetLock(async () => {
    const known = await prisma.nzbFile.findFirst({
      where: { indexerGuid: candidate.guid, status: { not: "broken" } },
      select: { id: true, s3Key: true },
    });
    if (known) return { kind: "known" as const, file: known };
    const budget = await getDownloadBudget();
    if (budget.used >= budget.max - BUDGET_RESERVE) return null;
    return ingestCandidate(request, candidate, tmdb);
  });
  if (!result) {
    await markFailed(request, "budget");
    return { status: "budget" };
  }
  switch (result.kind) {
    case "known":
      return attemptOwnFile(request, result.file.id, !!result.file.s3Key);
    case "created":
      return markDownloading(request, result.job.nzbFileId);
    case "conflict":
      return markDownloading(request, result.activeJob.nzbFileId);
    case "shared":
      return markDownloading(request, result.nzbFileId);
    case "already-available":
      return markReady(request, result.file.id);
    case "broken":
      return null;
    case "service-unavailable":
      await markFailed(request, "download_failed");
      return { status: "service_unavailable" };
    default:
      console.warn(`[movie-requests] Ingest for request ${request.id} returned ${result.kind}`);
      await markFailed(request, "download_failed");
      return { status: "failed" };
  }
}

async function attemptOwnFile(request: MovieRequest, nzbFileId: string, ready: boolean): Promise<RequestOutcome> {
  if (ready) return markReady(request, nzbFileId);
  try {
    await startDownloadJob(nzbFileId, request.userId);
  } catch (err) {
    // A serialization failure means a parallel click created the job; share it like a conflict.
    if (!isSerializationFailure(err)) throw err;
  }
  return markDownloading(request, nzbFileId);
}

function isTemporary(err: unknown): boolean {
  if (!(err instanceof IndexerError)) return false;
  const status = err.status ?? 0;
  return !(err.reason === "http" && status >= 400 && status < 500);
}

async function attemptCandidates(request: MovieRequest, ordered: MovieCandidate[]): Promise<RequestOutcome> {
  let { attempts, triedKeys } = request;
  let tmdb: TmdbMovieResult | undefined;
  for (const candidate of ordered) {
    if (attempts >= MAX_ATTEMPTS) break;
    if (candidate.state === "indexer") tmdb ??= await loadTmdb(request.tmdbId);
    attempts++;
    const untried = triedKeys;
    triedKeys = [...triedKeys, candidate.key];
    await prisma.movieRequest.update({ where: { id: request.id }, data: { attempts, triedKeys } });

    let outcome: RequestOutcome | null;
    try {
      outcome =
        candidate.state === "indexer"
          ? await attemptIndexerHit(request, candidate, tmdb!)
          : await attemptOwnFile(request, candidate.nzbFileId!, candidate.state === "ready");
    } catch (err) {
      if (isTemporary(err)) await prisma.movieRequest.update({ where: { id: request.id }, data: { triedKeys: untried } });
      throw err;
    }
    if (outcome) return outcome;
  }
  await markFailed(request, "no_candidate");
  return { status: "failed" };
}

export async function requestMovie(
  userId: string,
  tmdbId: number,
  key: string,
  opts: { confirmed: boolean; manual: boolean },
): Promise<RequestOutcome> {
  const { candidates } = await listMovieCandidates(tmdbId);
  // A guid key also matches the own NZB that replaced that indexer hit, so a
  // stale list from before another user's ingest still finds it.
  const chosen = candidates.find((c) => c.state !== "broken" && (c.key === key || `guid:${c.guid}` === key));
  if (!chosen) return { status: "candidate_gone" };
  if (chosen.group !== "german" && !opts.confirmed) return { status: "confirm_required", group: chosen.group };

  const fresh = {
    status: "downloading",
    allowedGroup: chosen.group,
    germanOnly: speaksGerman(chosen),
    manual: opts.manual,
    attempts: 0,
    triedKeys: [],
    failReason: null,
    nzbFileId: null,
  };
  const request = await prisma.movieRequest.upsert({
    where: { userId_tmdbId: { userId, tmdbId } },
    create: { userId, tmdbId, ...fresh },
    update: fresh,
  });
  return attemptCandidates(request, [chosen, ...fallbacks(request, candidates).filter((c) => c !== chosen)]);
}

async function retry(request: MovieRequest): Promise<void> {
  if (request.manual) {
    await markFailed(request, "download_failed");
    return;
  }
  const { candidates, indexer } = await listMovieCandidates(request.tmdbId);
  if (indexer === "unavailable") {
    console.warn(`[movie-requests] Indexer unavailable, retry of request ${request.id} deferred`);
    return;
  }
  await attemptCandidates(request, fallbacks(request, candidates));
}

async function rejectNonGerman(request: MovieRequest, audioLanguages: string[]): Promise<void> {
  const codes = toLanguageCodes(audioLanguages).filter((c) => c !== "und");
  if (codes.length === 0 || codes.includes("de")) {
    // ponytail: passed rows rotate via updatedAt; add an audioCheckedAt column if they ever crowd the batch.
    await prisma.movieRequest.update({ where: { id: request.id }, data: { updatedAt: new Date() } });
    return;
  }
  const nzbFileId = request.nzbFileId!;
  await prisma.nzbFile.update({ where: { id: nzbFileId }, data: { status: "broken", brokenReason: "Kein deutscher Ton (ffprobe)" } });
  await prisma.userLibrary.updateMany({ where: { userId: request.userId, nzbFileId }, data: { removedAt: new Date() } });
  await prisma.movieRequest.update({ where: { id: request.id }, data: { status: "downloading" } });
  await retry(request);
}

async function syncOne(requestId: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (err instanceof IndexerError || err instanceof TmdbUnavailableError) {
      console.warn(`[movie-requests] Retry of request ${requestId} deferred: ${err.message}`);
    } else {
      console.error(`[movie-requests] Sync of request ${requestId} failed:`, err);
    }
  }
}

export async function syncMovieRequests(): Promise<void> {
  const finished = await prisma.movieRequest.findMany({
    where: {
      status: "downloading",
      OR: [
        { nzbFileId: null, updatedAt: { lt: new Date(Date.now() - STALE_SEARCH_MS) } },
        { nzbFile: { s3Key: { not: null }, status: { not: "broken" } } },
        { nzbFile: { downloadJobs: { none: { status: { in: [...ACTIVE_JOB_STATUSES, "needs_review"] } } } } },
      ],
    },
    include: { nzbFile: { select: { s3Key: true, status: true } } },
    orderBy: { updatedAt: "asc" },
    take: SYNC_BATCH,
  });
  for (const request of finished) {
    const ready = request.nzbFile?.s3Key && request.nzbFile.status !== "broken";
    await syncOne(request.id, () => (ready ? markReady(request, request.nzbFileId!) : retry(request)));
  }

  const unchecked = await prisma.movieRequest.findMany({
    where: {
      status: "done",
      germanOnly: true,
      nzbFile: {
        mediaInfo: { not: Prisma.DbNull },
        NOT: [
          { audioLanguages: { hasSome: ["de", "ger", "deu"] } },
          { audioLanguages: { isEmpty: true } },
          { audioLanguages: { equals: ["und"] } },
        ],
      },
    },
    include: { nzbFile: { select: { audioLanguages: true } } },
    orderBy: { updatedAt: "asc" },
    take: SYNC_BATCH - finished.length,
  });
  for (const request of unchecked) {
    await syncOne(request.id, () => rejectNonGerman(request, request.nzbFile!.audioLanguages));
  }
}
