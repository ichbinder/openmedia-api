import prisma from "./prisma.js";
import { tmdbGet } from "./tmdb.js";
import type { Kind } from "./title-meta.js";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const OVERVIEW_MAX = 200;

export type TitleInfoView = {
  kind: Kind;
  tmdbId: number;
  name: string;
  year: number | null;
  genres: string[];
  overview: string;
  posterPath: string | null;
};

type Item = { kind: Kind; tmdbId: number };

export const titleKey = ({ kind, tmdbId }: Item) => `${kind}-${tmdbId}`;

const toView = (row: {
  kind: string;
  tmdbId: number;
  name: string;
  year: number | null;
  genres: string[];
  overview: string;
  posterPath: string | null;
}): TitleInfoView => ({
  kind: row.kind as Kind,
  tmdbId: row.tmdbId,
  name: row.name,
  year: row.year,
  genres: row.genres,
  overview: row.overview,
  posterPath: row.posterPath,
});

async function fetchInfo({ kind, tmdbId }: Item, now: Date) {
  const body = await tmdbGet(`/${kind === "movie" ? "movie" : "tv"}/${tmdbId}`, {}).catch(() => null);
  const name = body?.title ?? body?.name;
  if (!name) return null;
  const year = Number((body?.release_date ?? body?.first_air_date ?? "").slice(0, 4));
  const data = {
    name: String(name),
    year: Number.isInteger(year) && year > 0 ? year : null,
    genres: ((body?.genres ?? []) as { name?: string }[]).flatMap((g) => (g.name ? [g.name] : [])),
    overview: String(body?.overview ?? "").slice(0, OVERVIEW_MAX),
    posterPath: (body?.poster_path as string | null) ?? null,
    fetchedAt: now,
  };
  return prisma.titleInfo.upsert({
    where: { kind_tmdbId: { kind, tmdbId } },
    update: data,
    create: { kind, tmdbId, ...data },
  });
}

export async function getTitleInfos(items: Item[], now = new Date()): Promise<Map<string, TitleInfoView>> {
  const unique = [...new Map(items.map((i) => [titleKey(i), i])).values()];
  const rows = unique.length
    ? await prisma.titleInfo.findMany({
        where: { OR: unique.map(({ kind, tmdbId }) => ({ kind, tmdbId })) },
      })
    : [];
  const result = new Map<string, TitleInfoView>();
  for (const row of rows) {
    if (now.getTime() - row.fetchedAt.getTime() < TTL_MS) result.set(titleKey(row as Item), toView(row));
  }

  const missing = unique.filter((i) => !result.has(titleKey(i)));
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const item = missing[next++];
      const row = await fetchInfo(item, now);
      if (row) result.set(titleKey(item), toView(row));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return result;
}
