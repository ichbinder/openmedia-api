import { randomUUID } from "node:crypto";
import prisma from "./prisma.js";
import type { TasteInput } from "./taste.js";

export type Person = { id: string; name: string; limits: string[]; limitsText: string };
export type TraktImportCounts = { rated: number; seen: number; skipped: number };
export type TasteView = {
  exists: boolean;
  persons: Person[];
  genres: string[];
  likesText: string;
  traktImportedAt: string | null;
  traktImportCounts: TraktImportCounts | null;
};

const EMPTY: TasteView = {
  exists: false,
  persons: [],
  genres: [],
  likesText: "",
  traktImportedAt: null,
  traktImportCounts: null,
};

const toView = (p: {
  persons: unknown;
  genres: string[];
  likesText: string;
  traktImportedAt: Date | null;
  traktImportCounts: unknown;
}): TasteView => ({
  exists: true,
  persons: p.persons as Person[],
  genres: p.genres,
  likesText: p.likesText,
  traktImportedAt: p.traktImportedAt?.toISOString() ?? null,
  traktImportCounts: p.traktImportCounts as TraktImportCounts | null,
});

export async function getTaste(userId: string): Promise<TasteView> {
  const row = await prisma.tasteProfile.findUnique({ where: { userId } });
  return row ? toView(row) : EMPTY;
}

export async function saveTaste(userId: string, input: TasteInput): Promise<TasteView> {
  const persons: Person[] = input.persons.map((p) => ({ ...p, id: p.id ?? randomUUID() }));
  const keptIds = new Set(persons.map((p) => p.id));
  const data = { persons, genres: input.genres, likesText: input.likesText };

  return prisma.$transaction(async (tx) => {
    const previous = await tx.tasteProfile.findUnique({ where: { userId }, select: { persons: true } });
    const previousIds = ((previous?.persons ?? []) as { id: string }[]).map((p) => p.id);
    const removedIds = previousIds.filter((id) => !keptIds.has(id));
    if (removedIds.length) {
      await tx.titleRating.updateMany({ where: { userId, forWhom: { in: removedIds } }, data: { forWhom: null } });
    }
    const row = await tx.tasteProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return toView(row);
  });
}

export async function recordTraktImport(userId: string, counts: TraktImportCounts): Promise<void> {
  const data = { traktImportedAt: new Date(), traktImportCounts: counts };
  await prisma.tasteProfile.upsert({
    where: { userId },
    create: { userId, persons: [], ...data },
    update: data,
  });
}
