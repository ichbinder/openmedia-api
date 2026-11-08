import type { Prisma } from "../../generated/client/index.js";
import type { ParsedNzbName } from "./nzb-parser.js";
import { searchTmdbShowEpisode, type TmdbShowResult, type TmdbEpisodeResult } from "./tmdb.js";

export async function resolveEpisodeFromTmdb(
  parsed: ParsedNzbName,
  fallbackTitle: string,
): Promise<
  | { source: "tmdb-found"; show: TmdbShowResult; season: number; episode: number; tmdbEpisode: TmdbEpisodeResult | null }
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
  return { source: "tmdb-found", show: result.show, season: parsed.season, episode: parsed.episode, tmdbEpisode: result.episode };
}

export async function upsertEpisode(
  tx: Prisma.TransactionClient,
  show: TmdbShowResult,
  season: number,
  episode: number,
  tmdbEpisode: TmdbEpisodeResult | null,
): Promise<string> {
  await tx.nzbShow.createMany({
    data: [{
      tmdbId: show.tmdbId,
      titleDe: show.titleDe,
      titleEn: show.titleEn,
      description: show.description,
      year: show.year,
      posterPath: show.posterPath,
    }],
    skipDuplicates: true,
  });
  const nzbShow = await tx.nzbShow.findUniqueOrThrow({ where: { tmdbId: show.tmdbId } });

  await tx.nzbEpisode.createMany({
    data: [{
      showId: nzbShow.id,
      season,
      episode,
      titleDe: tmdbEpisode?.titleDe ?? "",
      airDate: tmdbEpisode?.airDate ? new Date(tmdbEpisode.airDate) : null,
    }],
    skipDuplicates: true,
  });
  const nzbEpisode = await tx.nzbEpisode.findUniqueOrThrow({
    where: { showId_season_episode: { showId: nzbShow.id, season, episode } },
  });
  return nzbEpisode.id;
}
