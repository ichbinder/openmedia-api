import prisma from "./prisma.js";
import { fetchMdblistTitle, type MdblistResult } from "./mdblist.js";
import {
  META_RULES,
  isStale,
  toRatings,
  type Brand,
  type Kind,
  type Ratings,
  type StoredRatings,
} from "./title-meta.js";

export type TitleMetaView = {
  kind: Kind;
  tmdbId: number;
  label: string | null;
  brand: Brand | null;
  ratings: Ratings;
  score: number | null;
};

type Item = { kind: Kind; tmdbId: number };
type Row = NonNullable<Awaited<ReturnType<typeof prisma.titleMeta.findFirst>>>;

const inFlight = new Map<string, Promise<Row | null>>();
const failedAt = new Map<string, number>();
const waiting: (() => void)[] = [];
let active = 0;
let warnedNotConfigured = false;

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= META_RULES.CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  else active++;
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const emptyView = ({ kind, tmdbId }: Item): TitleMetaView => ({
  kind,
  tmdbId,
  label: null,
  brand: null,
  ratings: {},
  score: null,
});

const toView = (row: Row): TitleMetaView => ({
  kind: row.kind as Kind,
  tmdbId: row.tmdbId,
  label: row.label,
  brand: row.brand as Brand | null,
  ratings: toRatings(row.ratings as StoredRatings),
  score: row.score,
});

const intOrNull = (v: number | null) => (v !== null && Number.isInteger(v) ? v : null);

function toData(result: MdblistResult) {
  if (result.status === "found") {
    return {
      status: "found",
      label: result.label,
      brand: result.brand,
      ratings: result.ratings,
      score: result.score !== null && Number.isFinite(result.score) ? Math.round(result.score) : null,
      year: intOrNull(result.year),
    };
  }
  return { status: "not_found", label: null, brand: null, ratings: {}, score: null, year: null };
}

async function lookup({ kind, tmdbId }: Item): Promise<Row | null> {
  const result = await limited(() => fetchMdblistTitle(kind, tmdbId));
  if (result.status === "error" && result.reason === "not_configured") {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn("[meta] MDBList-Key nicht konfiguriert, Herkunft und Bewertungen entfallen");
    }
    return null;
  }
  if (result.status === "error") {
    failedAt.set(`${kind}:${tmdbId}`, Date.now());
    console.warn(`[meta] MDBList-Abruf fehlgeschlagen: ${result.reason}`);
    return null;
  }
  failedAt.delete(`${kind}:${tmdbId}`);
  const data = { ...toData(result), fetchedAt: new Date() };
  try {
    return await prisma.titleMeta.upsert({
      where: { kind_tmdbId: { kind, tmdbId } },
      update: data,
      create: { kind, tmdbId, ...data },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return prisma.titleMeta.findUnique({ where: { kind_tmdbId: { kind, tmdbId } } });
    }
    throw e;
  }
}

function fetchShared(item: Item): Promise<Row | null> {
  const key = `${item.kind}:${item.tmdbId}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = lookup(item).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

export async function getMeta(items: Item[], now = new Date()): Promise<TitleMetaView[]> {
  const unique = [...new Map(items.map((i) => [`${i.kind}:${i.tmdbId}`, i])).values()];
  const rows = unique.length
    ? await prisma.titleMeta.findMany({
        where: { OR: unique.map(({ kind, tmdbId }) => ({ kind, tmdbId })) },
      })
    : [];
  const byKey = new Map<string, Row | null>(rows.map((r) => [`${r.kind}:${r.tmdbId}`, r]));

  await Promise.all(
    unique.map(async (item) => {
      const key = `${item.kind}:${item.tmdbId}`;
      const row = byKey.get(key);
      const lastFailure = failedAt.get(key);
      if (lastFailure !== undefined && now.getTime() - lastFailure < META_RULES.ERROR_BACKOFF_MS) return;
      if (!row) {
        byKey.set(key, await fetchShared(item).catch((e) => (console.error("[meta] Abruf fehlgeschlagen:", e), null)));
      } else if (isStale(row, now)) {
        fetchShared(item).catch((e) => console.error("[meta] Auffrischen fehlgeschlagen:", e));
      }
    }),
  );

  return items.map((item) => {
    const row = byKey.get(`${item.kind}:${item.tmdbId}`);
    return row ? toView(row) : emptyView(item);
  });
}
