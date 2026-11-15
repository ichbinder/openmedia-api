import prisma from "./prisma.js";
import { traktVerdict } from "./taste.js";
import { recordTraktImport } from "./taste-service.js";
import type { TraktLibrary } from "./trakt.js";

const PROTECTED_SOURCES = ["app", "quiz"];

export async function importTraktLibrary(userId: string, lib: TraktLibrary) {
  let skipped = 0;
  const candidates = new Map<string, { kind: string; tmdbId: number; verdict: "up" | "meh" | "down" | null }>();
  const key = (kind: string, tmdbId: number) => `${kind}:${tmdbId}`;

  for (const r of lib.ratings) {
    const verdict = traktVerdict(r.rating);
    if (r.tmdbId == null) skipped++;
    else if (verdict) candidates.set(key(r.kind, r.tmdbId), { kind: r.kind, tmdbId: r.tmdbId, verdict });
  }
  for (const w of lib.watched) {
    if (w.tmdbId == null) skipped++;
    else if (!candidates.has(key(w.kind, w.tmdbId))) {
      candidates.set(key(w.kind, w.tmdbId), { kind: w.kind, tmdbId: w.tmdbId, verdict: null });
    }
  }
  for (const r of lib.ratings) {
    if (r.tmdbId != null && !candidates.has(key(r.kind, r.tmdbId))) skipped++;
  }

  const protectedRows = await prisma.titleRating.findMany({
    where: { userId, source: { in: PROTECTED_SOURCES } },
    select: { kind: true, tmdbId: true },
  });
  const protectedKeys = new Set(protectedRows.map((p) => key(p.kind, p.tmdbId)));

  let rated = 0;
  let seen = 0;
  for (const c of candidates.values()) {
    if (protectedKeys.has(key(c.kind, c.tmdbId))) continue;
    const data = { verdict: c.verdict, tags: [], forWhom: null, source: "trakt" };
    await prisma.titleRating.upsert({
      where: { userId_kind_tmdbId: { userId, kind: c.kind, tmdbId: c.tmdbId } },
      create: { userId, kind: c.kind, tmdbId: c.tmdbId, ...data },
      update: data,
    });
    if (c.verdict) rated++;
    else seen++;
  }

  const counts = { rated, seen, skipped };
  await recordTraktImport(userId, counts);
  return counts;
}
