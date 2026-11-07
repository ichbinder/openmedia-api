import type { Prisma } from "../../generated/client/index.js";
import type { ParsedNzbName } from "./nzb-parser.js";
import { searchTmdbShowEpisode, type TmdbShowResult, type TmdbEpisodeResult } from "./tmdb.js";

export async function resolveEpisodeFromTmdb(
  parsed: ParsedNzbName,
  fallbackTitle: string,
): Promise<
  | { source: "tmdb-found"; show: TmdbShowResult; episode: TmdbEpisodeResult | null }
  | { source: "needs-review"; reason: "not-found" | "error"; errorDetail?: string }
  | { source: "tmdb-disabled"; reason: string }
> {
  const searchTitle = parsed.title || fallbackTitle;
  if (!searchTitle || parsed.season === null || parsed.episode === null) {
    return { source: "needs-review", reason: "not-found" };
  }

  const result = await searchTmdbShowEpisode(searchTitle, parsed.year, parsed.season, parsed.episode);

  if (result.status === "disabled") return { source: "tmdb-disabled", reason: result.reason };
  if (result.status === "error") {
    console.warn(`[matching] TMDB show error for "${searchTitle}": ${result.reason} — marking needs_review`);
    return { source: "needs-review", reason: "error", errorDetail: result.reason };
  }
  if (result.status === "not_found") {
    console.log(`[matching] No TMDB show match for "${searchTitle}" — marking needs_review`);
    return { source: "needs-review", reason: "not-found" };
  }
  return { source: "tmdb-found", show: result.show, episode: result.episode };
}

async function reuseOrCreate<T>(
  find: () => Promise<T | null>,
  create: () => Promise<T>,
): Promise<T> {
  const existing = await find();
  if (existing) return existing;
  try {
    return await create();
  } catch (err: any) {
    if (err?.code === "P2002") {
      const winner = await find();
      if (winner) return winner;
    }
    throw err;
  }
}

export async function upsertEpisode(
  tx: Prisma.TransactionClient,
  show: TmdbShowResult,
  season: number,
  episode: number,
  tmdbEpisode: TmdbEpisodeResult | null,
): Promise<string> {
  const nzbShow = await reuseOrCreate(
    () => tx.nzbShow.findUnique({ where: { tmdbId: show.tmdbId } }),
    () =>
      tx.nzbShow.create({
        data: {
          tmdbId: show.tmdbId,
          titleDe: show.titleDe,
          titleEn: show.titleEn,
          description: show.description,
          year: show.year,
          posterPath: show.posterPath,
        },
      }),
  );

  const key = { showId_season_episode: { showId: nzbShow.id, season, episode } };
  const nzbEpisode = await reuseOrCreate(
    () => tx.nzbEpisode.findUnique({ where: key }),
    () =>
      tx.nzbEpisode.create({
        data: {
          showId: nzbShow.id,
          season,
          episode,
          titleDe: tmdbEpisode?.titleDe ?? "",
          airDate: tmdbEpisode?.airDate ? new Date(tmdbEpisode.airDate) : null,
        },
      }),
  );
  return nzbEpisode.id;
}
