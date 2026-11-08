import { createHash } from "crypto";
import type { MovieRequest } from "../../generated/client/index.js";
import prisma from "./prisma.js";
import { searchTmdbMovieById, type TmdbMovieResult } from "./tmdb.js";
import { BUDGET_RESERVE, downloadNzb, getDownloadBudget, IndexerError, searchMovie, withBudgetLock } from "./treasure-maps.js";
import { getTargetBand } from "./release-ranking.js";
import { ingestNzb, type IngestResult } from "./nzb-ingest.js";
import { GROUP_RANK, rankMovieCandidates, type CandidateGroup, type MovieCandidate } from "./movie-ranking.js";
import { startDownloadJob } from "./download-jobs.js";
import { addToLibrary, TmdbUnavailableError } from "./episode-requests.js";

export const MAX_ATTEMPTS = 3;
export const DEFAULT_MOVIE_RUNTIME_MINUTES = 110;

export type RequestOutcome =
  | { status: "ready"; nzbFileId: string }
  | { status: "downloading"; nzbFileId: string }
  | { status: "confirm_required"; group: "foreign" | "cam" }
  | { status: "budget" }
  | { status: "candidate_gone" }
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

function fallbacks(request: MovieRequest, candidates: MovieCandidate[]): MovieCandidate[] {
  if (request.manual) return [];
  const allowed = GROUP_RANK[request.allowedGroup as CandidateGroup];
  return candidates.filter(
    (c) => c.state !== "broken" && !request.triedKeys.includes(c.key) && GROUP_RANK[c.group] <= allowed,
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
): Promise<IngestResult | { kind: "hash-race"; nzbFileId: string }> {
  const guid = candidate.guid!;
  const nzbContent = await downloadNzb(guid);
  try {
    return await ingestNzb({
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
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    const hash = createHash("sha256").update(nzbContent).digest("hex");
    const file = await prisma.nzbFile.findUniqueOrThrow({ where: { hash } });
    return { kind: "hash-race", nzbFileId: file.id };
  }
}

async function attemptIndexerHit(
  request: MovieRequest,
  candidate: MovieCandidate,
  tmdb: TmdbMovieResult,
): Promise<RequestOutcome | null> {
  const result = await withBudgetLock(async () => {
    const budget = await getDownloadBudget();
    if (budget.used >= budget.max - BUDGET_RESERVE) return null;
    return ingestCandidate(request, candidate, tmdb);
  });
  if (!result) {
    await markFailed(request, "budget");
    return { status: "budget" };
  }
  switch (result.kind) {
    case "created":
      return markDownloading(request, result.job.nzbFileId);
    case "conflict":
      return markDownloading(request, result.activeJob.nzbFileId);
    case "hash-race":
      return markDownloading(request, result.nzbFileId);
    case "already-available":
      return markReady(request, result.file.id);
    case "broken":
      return null;
    default:
      console.warn(`[movie-requests] Ingest for request ${request.id} returned ${result.kind}`);
      await markFailed(request, "download_failed");
      return { status: "failed" };
  }
}

async function attemptOwnFile(request: MovieRequest, candidate: MovieCandidate): Promise<RequestOutcome> {
  const nzbFileId = candidate.nzbFileId!;
  if (candidate.state === "ready") return markReady(request, nzbFileId);
  await startDownloadJob(nzbFileId, request.userId);
  return markDownloading(request, nzbFileId);
}

async function attemptCandidates(request: MovieRequest, ordered: MovieCandidate[]): Promise<RequestOutcome> {
  let { attempts, triedKeys } = request;
  let tmdb: TmdbMovieResult | undefined;
  for (const candidate of ordered) {
    if (attempts >= MAX_ATTEMPTS) break;
    if (candidate.state === "indexer") tmdb ??= await loadTmdb(request.tmdbId);
    attempts++;
    triedKeys = [...triedKeys, candidate.key];
    await prisma.movieRequest.update({ where: { id: request.id }, data: { attempts, triedKeys } });

    const outcome =
      candidate.state === "indexer"
        ? await attemptIndexerHit(request, candidate, tmdb!)
        : await attemptOwnFile(request, candidate);
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
