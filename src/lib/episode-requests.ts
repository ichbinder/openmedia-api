import { createHash } from "crypto";
import type { EpisodeRequest, NzbEpisode, NzbShow } from "../../generated/client/index.js";
import prisma from "./prisma.js";
import { getTmdbEpisodeById, getTmdbSeasonById } from "./tmdb.js";
import { downloadNzb, getDownloadBudget, IndexerError, searchEpisode } from "./treasure-maps.js";
import { getTargetBand, rankReleases, type RankedRelease } from "./release-ranking.js";
import { ingestNzb, type IngestResult } from "./nzb-ingest.js";
import { upsertEpisode } from "./episode-resolver.js";

export type RequestView = { season: number; episode: number; status: string; waitReason: string | null };

export class TmdbUnavailableError extends Error {
  constructor(public status: "disabled" | "error", reason: string) {
    super(`TMDB ${status}: ${reason}`);
    this.name = "TmdbUnavailableError";
  }
}

const ACTIVE_JOB_STATUSES = ["queued", "provisioning", "downloading", "uploading"];
const RETRY_MS = 60 * 60 * 1000;
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;
const BUDGET_RESERVE = 50;
const MAX_NZBS_PER_REQUEST = 3;
const SYNC_BATCH = 20;
const DEFAULT_RUNTIME_MINUTES = 45;
const TIER_PREFERENCE = ["1080p", "2160p", "720p", "480p"];

type FullRequest = EpisodeRequest & { episode: NzbEpisode & { show: NzbShow } };

function tierRank(tier: string | null): number {
  const index = TIER_PREFERENCE.indexOf(tier ?? "");
  return index === -1 ? TIER_PREFERENCE.length : index;
}

async function addToLibrary(userId: string, nzbFileId: string) {
  await prisma.userLibrary.upsert({
    where: { userId_nzbFileId: { userId, nzbFileId } },
    create: { userId, nzbFileId },
    update: { removedAt: null, addedAt: new Date() },
  });
}

async function markDone(request: EpisodeRequest, nzbFileId: string) {
  await addToLibrary(request.userId, nzbFileId);
  await prisma.episodeRequest.update({
    where: { id: request.id },
    data: { status: "done", nzbFileId, waitReason: null, nextSearchAt: null },
  });
}

function markDownloading(request: EpisodeRequest, nzbFileId: string) {
  return prisma.episodeRequest.update({
    where: { id: request.id },
    data: { status: "downloading", nzbFileId, waitReason: null, nextSearchAt: null },
  });
}

function markWaiting(request: EpisodeRequest, waitReason: "no_german" | "budget" | "indexer_error") {
  return prisma.episodeRequest.update({
    where: { id: request.id },
    data: { status: "waiting", waitReason, nextSearchAt: new Date(Date.now() + RETRY_MS) },
  });
}

export async function rankEpisodeCandidates(tmdbId: number, season: number, episode: number): Promise<RankedRelease[]> {
  const tmdb = await getTmdbEpisodeById(tmdbId, season, episode);
  const runtimeMinutes = (tmdb.status === "found" && tmdb.episode.runtime) || DEFAULT_RUNTIME_MINUTES;
  const band = await getTargetBand();
  const ranked = rankReleases(await searchEpisode(tmdbId, season, episode), { season, episode, runtimeMinutes, band });

  const broken = await prisma.nzbFile.findMany({
    where: { status: "broken", indexerGuid: { in: ranked.map((r) => r.guid) } },
    select: { indexerGuid: true },
  });
  const brokenGuids = new Set(broken.map((f) => f.indexerGuid));
  return ranked.filter((r) => !brokenGuids.has(r.guid));
}

async function ingestCandidate(
  request: FullRequest,
  candidate: RankedRelease,
): Promise<IngestResult | { kind: "hash-race"; nzbFileId: string }> {
  const { show } = request.episode;
  const nzbContent = await downloadNzb(candidate.guid);
  try {
    return await ingestNzb({
      nzbContent,
      title: candidate.title,
      filename: `${candidate.title}.nzb`,
      userId: request.userId,
      resolve: async () => ({
        source: "tmdb-found",
        show: {
          tmdbId: show.tmdbId,
          titleDe: show.titleDe,
          titleEn: show.titleEn,
          description: show.description,
          year: show.year,
          posterPath: show.posterPath,
        },
        season: request.episode.season,
        episode: request.episode.episode,
        tmdbEpisode: null,
      }),
      fileData: {
        indexerGuid: candidate.guid,
        qualityTier: candidate.qualityTier,
        resolution: candidate.qualityTier,
        fileSize: BigInt(candidate.size),
        audioLanguages: candidate.audioLanguages ?? [],
        subtitleLanguages: candidate.subtitles ?? [],
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

export async function fulfillEpisodeRequest(requestId: string): Promise<void> {
  const request = await prisma.episodeRequest.findUnique({
    where: { id: requestId },
    include: { episode: { include: { show: true } } },
  });
  if (!request || !["searching", "waiting"].includes(request.status)) return;
  const { episode } = request;

  const available = await prisma.nzbFile.findMany({
    where: {
      episodeId: episode.id,
      s3Key: { not: null },
      status: { not: "broken" },
      ...(request.manualGuid && { indexerGuid: request.manualGuid }),
    },
    select: { id: true, qualityTier: true },
  });
  if (available.length > 0) {
    const best = available.sort((a, b) => tierRank(a.qualityTier) - tierRank(b.qualityTier))[0];
    return markDone(request, best.id);
  }

  const activeJob = await prisma.downloadJob.findFirst({
    where: { status: { in: ACTIVE_JOB_STATUSES }, nzbFile: { episodeId: episode.id } },
    select: { nzbFileId: true },
  });
  if (activeJob) {
    await markDownloading(request, activeJob.nzbFileId);
    return;
  }

  try {
    let candidates = await rankEpisodeCandidates(episode.show.tmdbId, episode.season, episode.episode);
    if (request.manualGuid) candidates = candidates.filter((c) => c.guid === request.manualGuid);
    if (candidates.length === 0) {
      await markWaiting(request, "no_german");
      return;
    }

    const budget = await getDownloadBudget();
    if (budget.used >= budget.max - BUDGET_RESERVE) {
      await markWaiting(request, "budget");
      return;
    }

    for (const candidate of candidates.slice(0, MAX_NZBS_PER_REQUEST)) {
      const result = await ingestCandidate(request, candidate);
      switch (result.kind) {
        case "created":
          await markDownloading(request, result.job.nzbFileId);
          return;
        case "conflict":
          await markDownloading(request, result.activeJob.nzbFileId);
          return;
        case "hash-race":
          await markDownloading(request, result.nzbFileId);
          return;
        case "already-available":
          return markDone(request, result.file.id);
        case "broken":
          continue;
        default:
          console.warn(`[episode-requests] Ingest for request ${request.id} returned ${result.kind}`);
          await markWaiting(request, "indexer_error");
          return;
      }
    }
    await markWaiting(request, "no_german");
  } catch (err) {
    if (!(err instanceof IndexerError)) throw err;
    console.warn(`[episode-requests] Request ${request.id}: ${err.message}`);
    await markWaiting(request, "indexer_error");
  }
}

async function resolveTargets(tmdbId: number, season: number, episode?: number) {
  if (episode !== undefined) {
    const result = await getTmdbEpisodeById(tmdbId, season, episode);
    if (result.status === "not_found") return null;
    if (result.status !== "found") throw new TmdbUnavailableError(result.status, result.reason);
    return { show: result.show, episodes: [{ ...result.episode, episode }] };
  }
  const result = await getTmdbSeasonById(tmdbId, season);
  if (result.status === "not_found") return null;
  if (result.status !== "found") throw new TmdbUnavailableError(result.status, result.reason);
  const today = new Date().toISOString().slice(0, 10);
  return { show: result.show, episodes: result.episodes.filter((e) => e.airDate && e.airDate <= today) };
}

async function readViews(requestIds: string[]): Promise<RequestView[]> {
  const requests = await prisma.episodeRequest.findMany({
    where: { id: { in: requestIds } },
    include: { episode: { select: { season: true, episode: true } } },
    orderBy: [{ episode: { season: "asc" } }, { episode: { episode: "asc" } }],
  });
  return requests.map((r) => ({
    season: r.episode.season,
    episode: r.episode.episode,
    status: r.status,
    waitReason: r.waitReason,
  }));
}

export async function requestEpisodes(
  userId: string,
  tmdbId: number,
  season: number,
  episode?: number,
  manualGuid?: string,
): Promise<RequestView[]> {
  const targets = await resolveTargets(tmdbId, season, episode);
  if (!targets) return [];

  const episodeIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const e of targets.episodes) ids.push(await upsertEpisode(tx, targets.show, season, e.episode, e));
    return ids;
  });

  const requestIds: string[] = [];
  for (const episodeId of episodeIds) {
    const request = await prisma.episodeRequest.upsert({
      where: { userId_episodeId: { userId, episodeId } },
      create: { userId, episodeId, manualGuid },
      update: manualGuid ? { manualGuid } : {},
    });
    await prisma.episodeRequest.updateMany({
      where: { id: request.id, status: { in: ["expired", "waiting"] } },
      data: { status: "searching", createdAt: new Date(), waitReason: null, nextSearchAt: null },
    });
    requestIds.push(request.id);
  }

  if (episode !== undefined) {
    for (const id of requestIds) await fulfillEpisodeRequest(id);
    return readViews(requestIds);
  }

  const views = await readViews(requestIds);
  void (async () => {
    for (const id of requestIds) {
      try {
        await fulfillEpisodeRequest(id);
      } catch (err) {
        console.error(`[episode-requests] Background fulfil of ${id} failed:`, err);
      }
    }
  })();
  return views;
}

export async function syncEpisodeRequests(): Promise<void> {
  const downloading = await prisma.episodeRequest.findMany({
    where: { status: "downloading" },
    include: {
      nzbFile: {
        select: {
          s3Key: true,
          downloadJobs: { where: { status: { in: [...ACTIVE_JOB_STATUSES, "needs_review"] } }, select: { id: true } },
        },
      },
    },
  });

  const requeued: string[] = [];
  for (const request of downloading) {
    try {
      if (request.nzbFileId && request.nzbFile?.s3Key) {
        await markDone(request, request.nzbFileId);
      } else if (!request.nzbFile || request.nzbFile.downloadJobs.length === 0) {
        await prisma.episodeRequest.update({
          where: { id: request.id },
          data: { status: "waiting", waitReason: null, nextSearchAt: new Date() },
        });
        requeued.push(request.id);
      }
    } catch (err) {
      console.error(`[episode-requests] Sync of downloading request ${request.id} failed:`, err);
    }
  }

  // Requests requeued above are searched on the next run, not in this one.
  const due = await prisma.episodeRequest.findMany({
    where: { status: "waiting", nextSearchAt: { lte: new Date() }, id: { notIn: requeued } },
    orderBy: { createdAt: "asc" },
    take: SYNC_BATCH,
  });
  for (const request of due) {
    try {
      if (request.createdAt.getTime() < Date.now() - EXPIRE_MS) {
        await prisma.episodeRequest.update({ where: { id: request.id }, data: { status: "expired" } });
      } else {
        await fulfillEpisodeRequest(request.id);
      }
    } catch (err) {
      console.error(`[episode-requests] Sync of waiting request ${request.id} failed:`, err);
    }
  }
}
