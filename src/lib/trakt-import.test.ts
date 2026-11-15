import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import prisma from "./prisma.js";
import { importTraktLibrary } from "./trakt-import.js";

const app = createApp();

describe("importTraktLibrary", () => {
  let userId: string;
  const row = (tmdbId: number) =>
    prisma.titleRating.findUnique({ where: { userId_kind_tmdbId: { userId, kind: "movie", tmdbId } } });

  beforeEach(async () => {
    const res = await request(app).post("/auth/register").send({ email: "trakt-import@test.de", password: "test123", name: "T" });
    userId = res.body.user.id;
  });

  it("Bewertung schlägt gesehen: eine Zeile, rated 1", async () => {
    const counts = await importTraktLibrary(userId, {
      ratings: [{ kind: "movie", tmdbId: 1, rating: 9 }],
      watched: [{ kind: "movie", tmdbId: 1 }],
    });
    expect(counts).toEqual({ rated: 1, seen: 0, skipped: 0 });
    expect(await prisma.titleRating.count({ where: { userId } })).toBe(1);
    expect(await row(1)).toMatchObject({ verdict: "up", source: "trakt", tags: [], forWhom: null });
  });

  it("gesehen ohne Bewertung: verdict null", async () => {
    const counts = await importTraktLibrary(userId, { ratings: [], watched: [{ kind: "movie", tmdbId: 2 }] });
    expect(counts).toEqual({ rated: 0, seen: 1, skipped: 0 });
    expect((await row(2))?.verdict).toBeNull();
  });

  it("ohne tmdbId: skipped", async () => {
    const counts = await importTraktLibrary(userId, { ratings: [], watched: [{ kind: "movie", tmdbId: null }] });
    expect(counts).toEqual({ rated: 0, seen: 0, skipped: 1 });
  });

  it("Bewertung außerhalb 1-10: gesehen zählt als seen, sonst skipped", async () => {
    const counts = await importTraktLibrary(userId, {
      ratings: [{ kind: "movie", tmdbId: 3, rating: 0 }, { kind: "movie", tmdbId: 4, rating: 0 }],
      watched: [{ kind: "movie", tmdbId: 3 }],
    });
    expect(counts).toEqual({ rated: 0, seen: 1, skipped: 1 });
    expect(await row(4)).toBeNull();
  });

  it("app-Zeile bleibt unverändert und zählt nicht", async () => {
    await prisma.titleRating.create({ data: { userId, kind: "movie", tmdbId: 5, verdict: "down", tags: [], source: "app" } });
    const counts = await importTraktLibrary(userId, { ratings: [{ kind: "movie", tmdbId: 5, rating: 10 }], watched: [] });
    expect(counts).toEqual({ rated: 0, seen: 0, skipped: 0 });
    expect(await row(5)).toMatchObject({ verdict: "down", source: "app" });
  });

  it("trakt-Zeile wird aktualisiert; Profil bekommt Zähler", async () => {
    await prisma.titleRating.create({ data: { userId, kind: "movie", tmdbId: 6, verdict: "meh", tags: [], source: "trakt" } });
    await importTraktLibrary(userId, { ratings: [{ kind: "movie", tmdbId: 6, rating: 9 }], watched: [] });
    expect((await row(6))?.verdict).toBe("up");
    const profile = await prisma.tasteProfile.findUnique({ where: { userId } });
    expect(profile?.traktImportedAt).toBeInstanceOf(Date);
    expect(profile?.traktImportCounts).toEqual({ rated: 1, seen: 0, skipped: 0 });
  });
});
