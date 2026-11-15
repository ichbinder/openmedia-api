import prisma from "./prisma.js";
import { getTmdbSeasonById } from "./tmdb.js";
import { PROGRESS, isFinishedPosition, pickStreamableFile, resumePosition, titleState } from "./watch-progress.js";

const MAX_SEC = 7 * 24 * 60 * 60;

export type Resume = { positionSec: number; durationSec: number; finished: boolean };

export type RecordResult =
  | { status: "ok"; progress: Resume }
  | { status: "invalid" }
  | { status: "not_found" };

export async function recordProgress(
  userId: string,
  nzbFileId: string,
  positionSec: number,
  durationSec: number,
): Promise<RecordResult> {
  const position = Math.round(positionSec);
  const duration = Math.round(durationSec);
  if (
    !Number.isFinite(position) ||
    !Number.isFinite(duration) ||
    position < 0 ||
    duration <= 0 ||
    duration > MAX_SEC ||
    position > MAX_SEC ||
    position > duration * (1 + PROGRESS.LENGTH_TOLERANCE) + 5
  ) {
    return { status: "invalid" };
  }

  const file = await prisma.nzbFile.findUnique({
    where: { id: nzbFileId },
    select: { movieId: true, episodeId: true },
  });
  if (!file || (!file.movieId && !file.episodeId)) return { status: "not_found" };

  const now = new Date();
  const finishedNow = isFinishedPosition(position, duration);

  const where = file.movieId
    ? { userId_movieId: { userId, movieId: file.movieId } }
    : { userId_episodeId: { userId, episodeId: file.episodeId! } };

  let row = await prisma.watchProgress.upsert({
    where,
    create: {
      userId,
      movieId: file.movieId,
      episodeId: file.episodeId,
      nzbFileId,
      positionSec: position,
      durationSec: duration,
      finishedAt: finishedNow ? now : null,
    },
    update: {
      nzbFileId,
      positionSec: position,
      durationSec: duration,
      hiddenAt: null,
    },
  });

  if (finishedNow && !row.finishedAt) {
    row = await prisma.watchProgress.update({ where: { id: row.id }, data: { finishedAt: now } });
  }

  return {
    status: "ok",
    progress: { positionSec: row.positionSec, durationSec: row.durationSec, finished: row.finishedAt !== null },
  };
}

export async function getResume(
  userId: string,
  file: { movieId: string | null; episodeId: string | null; duration: number | null },
): Promise<Resume | null> {
  if (!file.movieId && !file.episodeId) return null;
  const row = await prisma.watchProgress.findFirst({
    where: file.movieId ? { userId, movieId: file.movieId } : { userId, episodeId: file.episodeId },
  });
  if (!row || titleState(row) !== "started") return null;
  return {
    positionSec: resumePosition(row, file.duration),
    durationSec: file.duration ?? row.durationSec,
    finished: false,
  };
}

export type EpisodeAvailability = {
  nzbFileId: string | null;
  request: { status: string; waitReason: string | null } | null;
};

export type NextEpisode = {
  showTmdbId: number;
  season: number;
  episode: number;
  titleDe: string;
} & EpisodeAvailability;

export type ContinueItem = {
  kind: "movie" | "episode";
  tmdbId: number;
  title: string;
  posterPath: string | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  positionSec: number;
  durationSec: number;
  updatedAt: string;
} & EpisodeAvailability;

const OPEN_EPISODE_REQUEST = ["searching", "waiting", "downloading"];

async function episodeAvailability(
  userId: string,
  showId: string,
  season: number,
  episode: number,
): Promise<EpisodeAvailability> {
  const row = await prisma.nzbEpisode.findUnique({
    where: { showId_season_episode: { showId, season, episode } },
    include: {
      nzbFiles: true,
      episodeRequests: { where: { userId, status: { in: OPEN_EPISODE_REQUEST } }, take: 1 },
    },
  });
  if (!row) return { nzbFileId: null, request: null };
  const open = row.episodeRequests[0];
  return {
    nzbFileId: pickStreamableFile(row.nzbFiles)?.id ?? null,
    request: open ? { status: open.status, waitReason: open.waitReason } : null,
  };
}

async function firstAfter(showTmdbId: number, season: number, after: number) {
  const result = await getTmdbSeasonById(showTmdbId, season);
  if (result.status !== "found") return undefined;
  return result.episodes.filter((e) => e.episode > after).sort((a, b) => a.episode - b.episode)[0] ?? null;
}

export async function findNextEpisode(
  userId: string,
  showTmdbId: number,
  season: number,
  episode: number,
): Promise<NextEpisode | null> {
  let nextSeason = season;
  let next = await firstAfter(showTmdbId, season, episode);
  if (next === undefined) return null;
  if (!next && season >= 1) {
    nextSeason = season + 1;
    next = await firstAfter(showTmdbId, nextSeason, 0);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!next || !next.airDate || next.airDate.slice(0, 10) > today) return null;

  const show = await prisma.nzbShow.findUnique({ where: { tmdbId: showTmdbId }, select: { id: true } });
  const availability = show
    ? await episodeAvailability(userId, show.id, nextSeason, next.episode)
    : { nzbFileId: null, request: null };
  return { showTmdbId, season: nextSeason, episode: next.episode, titleDe: next.titleDe, ...availability };
}

type Candidate = { updatedAt: Date; resolve: () => Promise<ContinueItem | null> };

async function movieCandidates(userId: string): Promise<Candidate[]> {
  const rows = await prisma.watchProgress.findMany({
    where: { userId, movieId: { not: null }, hiddenAt: null },
    include: { movie: true },
  });
  const started = rows.filter((r) => r.movie?.tmdbId != null && titleState(r) === "started");
  const [requests, files] = await Promise.all([
    prisma.movieRequest.findMany({ where: { userId, tmdbId: { in: started.map((r) => r.movie!.tmdbId!) } } }),
    prisma.nzbFile.findMany({ where: { movieId: { in: started.map((r) => r.movieId!) } } }),
  ]);
  const requestByTmdb = new Map(requests.map((r) => [r.tmdbId, r]));

  return started.map((r) => ({
    updatedAt: r.updatedAt,
    resolve: async () => {
      const movie = r.movie!;
      const request = requestByTmdb.get(movie.tmdbId!);
      return {
        kind: "movie",
        tmdbId: movie.tmdbId!,
        title: movie.titleDe,
        posterPath: movie.posterPath,
        season: null,
        episode: null,
        episodeTitle: null,
        positionSec: r.positionSec,
        durationSec: r.durationSec,
        updatedAt: r.updatedAt.toISOString(),
        nzbFileId: pickStreamableFile(files.filter((f) => f.movieId === movie.id))?.id ?? null,
        request: request ? { status: request.status, waitReason: request.failReason } : null,
      };
    },
  }));
}

async function showCandidates(userId: string): Promise<Candidate[]> {
  const rows = await prisma.watchProgress.findMany({
    where: { userId, episodeId: { not: null } },
    include: { episode: { include: { show: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const newestPerShow = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (titleState(r) !== "new" && !newestPerShow.has(r.episode!.showId)) newestPerShow.set(r.episode!.showId, r);
  }

  return [...newestPerShow.values()]
    .filter((r) => !r.hiddenAt)
    .map((r) => ({
      updatedAt: r.updatedAt,
      resolve: async () => {
        const ep = r.episode!;
        const show = ep.show;
        const base = {
          kind: "episode" as const,
          tmdbId: show.tmdbId,
          title: show.titleDe,
          posterPath: show.posterPath,
          updatedAt: r.updatedAt.toISOString(),
        };
        try {
          if (titleState(r) === "started") {
            return {
              ...base,
              season: ep.season,
              episode: ep.episode,
              episodeTitle: ep.titleDe || null,
              positionSec: r.positionSec,
              durationSec: r.durationSec,
              ...(await episodeAvailability(userId, show.id, ep.season, ep.episode)),
            };
          }
          const next = await findNextEpisode(userId, show.tmdbId, ep.season, ep.episode);
          if (!next) return null;
          return {
            ...base,
            season: next.season,
            episode: next.episode,
            episodeTitle: next.titleDe || null,
            positionSec: 0,
            durationSec: 0,
            nzbFileId: next.nzbFileId,
            request: next.request,
          };
        } catch (err) {
          console.error("[progress] Continue entry error:", err);
          return null;
        }
      },
    }));
}

export async function listContinue(userId: string): Promise<ContinueItem[]> {
  const [movies, shows] = await Promise.all([movieCandidates(userId), showCandidates(userId)]);
  const candidates = [...movies, ...shows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const items: ContinueItem[] = [];
  for (const candidate of candidates) {
    if (items.length >= PROGRESS.CONTINUE_LIMIT) break;
    const item = await candidate.resolve();
    if (item) items.push(item);
  }
  return items;
}

export async function hideContinue(userId: string, kind: "movie" | "show", tmdbId: number): Promise<number> {
  const where =
    kind === "movie" ? { userId, movie: { tmdbId } } : { userId, episode: { show: { tmdbId } } };
  const { count } = await prisma.watchProgress.updateMany({ where, data: { hiddenAt: new Date() } });
  return count;
}

export async function nextForFile(userId: string, nzbFileId: string): Promise<NextEpisode | null | "not_found"> {
  const file = await prisma.nzbFile.findUnique({
    where: { id: nzbFileId },
    include: { episode: { include: { show: true } } },
  });
  if (!file) return "not_found";
  if (!file.episode) return null;
  return findNextEpisode(userId, file.episode.show.tmdbId, file.episode.season, file.episode.episode);
}
