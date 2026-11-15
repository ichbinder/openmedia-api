import prisma from "./prisma.js";
import type { RatingInput, Verdict } from "./taste.js";
import type { Kind } from "./title-meta.js";

export type RatingView = {
  kind: Kind;
  tmdbId: number;
  verdict: Verdict | null;
  tags: string[];
  forWhom: string | null;
  source: "app" | "quiz" | "trakt";
  ratedAt: string;
};

const toView = (r: {
  kind: string;
  tmdbId: number;
  verdict: string | null;
  tags: string[];
  forWhom: string | null;
  source: string;
  ratedAt: Date;
}): RatingView => ({
  kind: r.kind as Kind,
  tmdbId: r.tmdbId,
  verdict: r.verdict as Verdict | null,
  tags: r.tags,
  forWhom: r.forWhom,
  source: r.source as RatingView["source"],
  ratedAt: r.ratedAt.toISOString(),
});

export async function listRatings(userId: string): Promise<RatingView[]> {
  const rows = await prisma.titleRating.findMany({ where: { userId }, orderBy: { ratedAt: "desc" } });
  return rows.map(toView);
}

export async function getRating(userId: string, kind: Kind, tmdbId: number): Promise<RatingView | null> {
  const row = await prisma.titleRating.findUnique({ where: { userId_kind_tmdbId: { userId, kind, tmdbId } } });
  return row && toView(row);
}

export async function saveRating(userId: string, kind: Kind, tmdbId: number, input: RatingInput): Promise<RatingView> {
  const data = { verdict: input.verdict, tags: input.tags, forWhom: input.forWhom, source: input.source, ratedAt: new Date() };
  const row = await prisma.titleRating.upsert({
    where: { userId_kind_tmdbId: { userId, kind, tmdbId } },
    create: { userId, kind, tmdbId, ...data },
    update: data,
  });
  return toView(row);
}

export async function deleteRating(userId: string, kind: Kind, tmdbId: number): Promise<boolean> {
  const { count } = await prisma.titleRating.deleteMany({ where: { userId, kind, tmdbId } });
  return count > 0;
}

export async function personIds(userId: string): Promise<string[]> {
  const profile = await prisma.tasteProfile.findUnique({ where: { userId }, select: { persons: true } });
  const persons = Array.isArray(profile?.persons) ? (profile.persons as { id?: unknown }[]) : [];
  return persons.map((p) => p.id).filter((id): id is string => typeof id === "string");
}
