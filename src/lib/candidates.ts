import prisma from "./prisma.js";
import { tmdbGet } from "./tmdb.js";
import { mdblistGet } from "./mdblist.js";
import { getMeta } from "./meta-service.js";
import { getTitleInfos, titleKey, type TitleInfoView } from "./title-info.js";
import type { Kind } from "./title-meta.js";

export type Hint = "neu" | "aehnlich" | "serien" | "perlen";
export type Candidate = TitleInfoView & {
  hints: Hint[];
  label: string | null;
  critics: number | null;
  audience: number | null;
};

type Item = { kind: Kind; tmdbId: number };
type Because = (Item & { name: string }) | null;
type Source = { hint: Hint; items: Item[] };

const DAY_MS = 24 * 60 * 60 * 1000;
const RELEASE_DAYS = 90;
const RELEASE_WINDOW_DAYS = 35;
const MAX_CANDIDATES = 500;
const RECENT_RUNS = 7;
const MAX_SERIES_SEEDS = 5;
const PERLEN_PAGES = 5;
const PERLEN_MIN_VOTES = "500";
const LIKED = "up";

const MOVIE_GENRES: Record<string, number> = {
  thriller: 53, mystery: 9648, krimi: 80, drama: 18, romantik: 10749, komoedie: 35, scifi: 878,
  fantasy: 14, action: 28, horror: 27, doku: 99, animation: 16, historie: 36, familie: 10751,
};
const TV_GENRES: Record<string, number> = {
  mystery: 9648, krimi: 80, drama: 18, komoedie: 35, scifi: 10765, fantasy: 10765,
  action: 10759, doku: 99, animation: 16, familie: 10751,
};

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const tmdbPath = (kind: Kind) => (kind === "movie" ? "movie" : "tv");

function shuffled<T>(list: T[], random: () => number): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export async function excludedKeys(userId: string): Promise<Set<string>> {
  const [ratings, dismissals, progress] = await Promise.all([
    prisma.titleRating.findMany({ where: { userId }, select: { kind: true, tmdbId: true } }),
    prisma.titleDismissal.findMany({ where: { userId }, select: { kind: true, tmdbId: true } }),
    prisma.watchProgress.findMany({
      where: { userId },
      select: { movie: { select: { tmdbId: true } }, episode: { select: { show: { select: { tmdbId: true } } } } },
    }),
  ]);
  const keys = new Set<string>();
  for (const r of [...ratings, ...dismissals]) keys.add(titleKey(r as Item));
  for (const p of progress) {
    if (p.movie?.tmdbId) keys.add(titleKey({ kind: "movie", tmdbId: p.movie.tmdbId }));
    if (p.episode) keys.add(titleKey({ kind: "show", tmdbId: p.episode.show.tmdbId }));
  }
  return keys;
}

const likedTitles = (userId: string) =>
  prisma.titleRating.findMany({ where: { userId, verdict: LIKED }, select: { kind: true, tmdbId: true } });

async function titleName(kind: string, tmdbId: number): Promise<string> {
  const info = (await getTitleInfos([{ kind: kind as Kind, tmdbId }])).get(`${kind}-${tmdbId}`);
  return info?.name ?? "";
}

export async function pickBecauseTitle(
  userId: string,
  random: () => number = Math.random,
): Promise<{ kind: Kind; tmdbId: number; name: string } | null> {
  const [liked, runs] = await Promise.all([
    likedTitles(userId),
    prisma.suggestionRun.findMany({
      where: { userId },
      orderBy: { startedAt: "desc" },
      take: RECENT_RUNS,
      select: { becauseKind: true, becauseTmdbId: true },
    }),
  ]);
  const recent = new Set(runs.map((r) => `${r.becauseKind}-${r.becauseTmdbId}`));
  const options = liked.filter((t) => !recent.has(titleKey(t as Item)));
  if (!options.length) return null;
  const pick = options[Math.floor(random() * options.length)];
  return { kind: pick.kind as Kind, tmdbId: pick.tmdbId, name: await titleName(pick.kind, pick.tmdbId) };
}

async function results(path: string, params: Record<string, string>, kind: Kind): Promise<Item[]> {
  const body = await tmdbGet(path, params).catch(() => null);
  const rows: { id?: unknown }[] = Array.isArray(body?.results) ? body.results : [];
  return rows.flatMap((r) => (positiveInt(r.id) ? [{ kind, tmdbId: r.id }] : []));
}

const recommendations = (kind: Kind, tmdbId: number, pages: number[]) =>
  Promise.all(pages.map((page) => results(`/${tmdbPath(kind)}/${tmdbId}/recommendations`, { page: String(page) }, kind))).then(
    (lists) => lists.flat(),
  );

// MDBList response shapes beyond the documented row fields are unconfirmed, so rows are located defensively.
function mdblistRows(body: unknown): Record<string, any>[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const list = Object.values(body).find(Array.isArray);
    if (list) return list as Record<string, any>[];
  }
  return [];
}

function mdblistItem(row: Record<string, any>, fallback: Kind): Item | null {
  const tmdbId = row.tmdb ?? row.ids?.tmdb ?? row.tmdb_id;
  if (!positiveInt(tmdbId)) return null;
  const type = row.type ?? row.mediatype ?? row.media_type;
  return { kind: type === "show" || type === "tv" ? "show" : type === "movie" ? "movie" : fallback, tmdbId };
}

async function digitalReleases(now: Date): Promise<Item[]> {
  const windows = Array.from({ length: Math.ceil(RELEASE_DAYS / RELEASE_WINDOW_DAYS) }, (_, i) => {
    const endOffset = i * RELEASE_WINDOW_DAYS;
    const startOffset = Math.min(RELEASE_DAYS, endOffset + RELEASE_WINDOW_DAYS - 1);
    return {
      start: isoDate(new Date(now.getTime() - startOffset * DAY_MS)),
      end: isoDate(new Date(now.getTime() - endOffset * DAY_MS)),
    };
  });
  const bodies = await Promise.all(windows.map((w) => mdblistGet("/releases", { type: "digital", ...w })));
  return bodies.flatMap((b) => mdblistRows(b).flatMap((r) => mdblistItem(r, "movie") ?? []));
}

async function justwatchCharts(kind: Kind): Promise<Item[]> {
  const body = await mdblistGet(`/justwatch/streaming-charts/${kind}`, { country: "DE", period: "weekly" });
  return mdblistRows(body).flatMap((r) => {
    const item = mdblistItem(r, kind);
    return item ? [{ ...item, kind }] : [];
  });
}

const genreFilter = (genres: string[], map: Record<string, number>): Record<string, string> => {
  const ids = [...new Set(genres.flatMap((g) => (map[g] ? [map[g]] : [])))];
  return ids.length ? { with_genres: ids.join("|") } : {};
};

async function perlen(genres: string[], now: Date, random: () => number): Promise<Item[]> {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 3);
  const common = { sort_by: "vote_average.desc", "vote_count.gte": PERLEN_MIN_VOTES };
  const page = () => String(1 + Math.floor(random() * PERLEN_PAGES));
  const [movies, shows] = await Promise.all([
    results(
      "/discover/movie",
      { ...common, ...genreFilter(genres, MOVIE_GENRES), "primary_release_date.lte": isoDate(cutoff), page: page() },
      "movie",
    ),
    results(
      "/discover/tv",
      { ...common, ...genreFilter(genres, TV_GENRES), "first_air_date.lte": isoDate(cutoff), page: page() },
      "show",
    ),
  ]);
  return [...movies, ...shows];
}

function interleave(lists: Item[][]): Item[] {
  const out: Item[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

export async function collectCandidates(
  userId: string,
  because: Because,
  now = new Date(),
  random: () => number = Math.random,
): Promise<Candidate[]> {
  const [profile, liked, excluded] = await Promise.all([
    prisma.tasteProfile.findUnique({ where: { userId }, select: { genres: true } }),
    likedTitles(userId),
    excludedKeys(userId),
  ]);
  const seedShows = shuffled(liked.filter((t) => t.kind === "show"), random).slice(0, MAX_SERIES_SEEDS);

  const neuLists = await Promise.all([
    digitalReleases(now),
    justwatchCharts("movie"),
    justwatchCharts("show"),
    results(
      "/discover/tv",
      {
        sort_by: "popularity.desc",
        "first_air_date.gte": isoDate(new Date(now.getTime() - RELEASE_DAYS * DAY_MS)),
        "first_air_date.lte": isoDate(now),
      },
      "show",
    ),
  ]);
  const [aehnlich, serienLists, perlenItems] = await Promise.all([
    because ? recommendations(because.kind, because.tmdbId, [1, 2]) : Promise.resolve([]),
    Promise.all(seedShows.map((t) => recommendations("show", t.tmdbId, [1]))),
    perlen(profile?.genres ?? [], now, random),
  ]);

  const sources: Source[] = [
    { hint: "neu", items: interleave(neuLists) },
    { hint: "aehnlich", items: aehnlich },
    { hint: "serien", items: serienLists.flat() },
    { hint: "perlen", items: perlenItems },
  ];

  const hintsByKey = new Map<string, { item: Item; hints: Hint[] }>();
  const order = interleave(sources.map((s) => s.items));
  for (const source of sources) {
    for (const item of source.items) {
      const key = titleKey(item);
      if (excluded.has(key)) continue;
      const entry = hintsByKey.get(key) ?? { item, hints: [] };
      if (!entry.hints.includes(source.hint)) entry.hints.push(source.hint);
      hintsByKey.set(key, entry);
    }
  }

  const ranked = [...new Map(order.map((i) => [titleKey(i), i])).values()].filter((i) => hintsByKey.has(titleKey(i)));
  const infos = await getTitleInfos(ranked);
  const kept = ranked.filter((i) => infos.has(titleKey(i))).slice(0, MAX_CANDIDATES);

  const metas = new Map((await getMeta(kept, now)).map((m) => [titleKey(m), m]));
  return kept.map((item) => {
    const key = titleKey(item);
    const meta = metas.get(key);
    return {
      ...infos.get(key)!,
      hints: hintsByKey.get(key)!.hints,
      label: meta?.label ?? null,
      critics: meta?.ratings.critics ?? null,
      audience: meta?.ratings.audience ?? null,
    };
  });
}
