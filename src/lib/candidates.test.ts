import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../test/setup.js";

vi.mock("./tmdb.js", () => ({ tmdbGet: vi.fn() }));
vi.mock("./mdblist.js", () => ({ mdblistGet: vi.fn() }));
vi.mock("./meta-service.js", () => ({ getMeta: vi.fn() }));

import { tmdbGet } from "./tmdb.js";
import { mdblistGet } from "./mdblist.js";
import { getMeta } from "./meta-service.js";
import { collectCandidates, excludedKeys, pickBecauseTitle } from "./candidates.js";

const mockTmdb = vi.mocked(tmdbGet);
const mockMdblist = vi.mocked(mdblistGet);
const mockMeta = vi.mocked(getMeta);

let counter = 0;
const createUser = () => {
  counter++;
  return prisma.user.create({ data: { email: `cand-${counter}-${Date.now()}@test.de`, name: "U", password: "x" } });
};

const rate = (userId: string, kind: string, tmdbId: number, verdict: string | null) =>
  prisma.titleRating.create({ data: { userId, kind, tmdbId, verdict, tags: [], source: "app" } });

function tmdbRoutes(routes: Record<string, number[]>) {
  mockTmdb.mockImplementation(async (path) => {
    const hit = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    if (hit) return { results: hit[1].map((id) => ({ id })) };
    const detail = /^\/(movie|tv)\/(\d+)$/.exec(path);
    return detail ? { title: `T${detail[2]}`, name: `T${detail[2]}`, genres: [], overview: "" } : { results: [] };
  });
}

beforeEach(() => {
  mockTmdb.mockReset();
  mockMdblist.mockReset().mockResolvedValue(null);
  mockMeta.mockReset().mockImplementation(async (items) =>
    items.map((i) => ({ ...i, label: null, brand: null, ratings: {}, score: null })),
  );
});

describe("excludedKeys", () => {
  it("covers ratings, dismissals and any watch progress, only for this account", async () => {
    const user = await createUser();
    const other = await createUser();
    await rate(user.id, "movie", 100, null);
    await prisma.titleDismissal.create({ data: { userId: user.id, kind: "show", tmdbId: 200 } });
    await rate(other.id, "movie", 999, "up");
    const show = await prisma.nzbShow.create({ data: { tmdbId: 300, titleDe: "S", titleEn: "S" } });
    const episode = await prisma.nzbEpisode.create({ data: { showId: show.id, season: 1, episode: 1 } });
    await prisma.watchProgress.create({
      data: { userId: user.id, episodeId: episode.id, positionSec: 1, durationSec: 2, finishedAt: new Date(), hiddenAt: new Date() },
    });

    const keys = await excludedKeys(user.id);
    expect(keys).toEqual(new Set(["movie-100", "show-200", "show-300"]));
  });
});

describe("pickBecauseTitle", () => {
  it("returns null without a liked title", async () => {
    const user = await createUser();
    await rate(user.id, "movie", 1, "meh");
    expect(await pickBecauseTitle(user.id)).toBeNull();
  });

  it("skips a title used by the recent runs", async () => {
    const user = await createUser();
    await rate(user.id, "movie", 11, "up");
    await rate(user.id, "show", 12, "up");
    await prisma.suggestionRun.create({
      data: { userId: user.id, status: "ok", model: "m", becauseKind: "movie", becauseTmdbId: 11 },
    });
    tmdbRoutes({});
    for (const random of [() => 0, () => 0.99]) {
      expect(await pickBecauseTitle(user.id, random)).toMatchObject({ kind: "show", tmdbId: 12 });
    }
  });
});

describe("collectCandidates", () => {
  it("merges hints, drops excluded titles and works without because", async () => {
    const user = await createUser();
    await rate(user.id, "movie", 501, "meh");
    mockMdblist.mockImplementation(async (path) =>
      path === "/releases"
        ? { releases: [{ tmdb: 500 }, { tmdb: 501 }] }
        : path.includes("/movie")
          ? [{ ids: { tmdb: 500 } }]
          : [],
    );
    tmdbRoutes({});
    const result = await collectCandidates(user.id, null);
    expect(result.map((c) => [c.tmdbId, c.hints])).toEqual([[500, ["neu"]]]);
    expect(result.every((c) => !c.hints.includes("aehnlich"))).toBe(true);
    expect(result[0]).toMatchObject({ critics: null, audience: null, label: null });
  });

  it("maps ratings and label from getMeta", async () => {
    const user = await createUser();
    mockMdblist.mockResolvedValue([{ tmdb: 510 }]);
    tmdbRoutes({});
    mockMeta.mockResolvedValue([
      { kind: "movie", tmdbId: 510, label: "NETFLIX", brand: "netflix", ratings: { critics: 88, audience: 70 }, score: 80 },
    ]);
    const [c] = await collectCandidates(user.id, null);
    expect(c).toMatchObject({ label: "NETFLIX", critics: 88, audience: 70 });
  });

  it("adds aehnlich hints from because and queries perlen older than 3 years", async () => {
    const user = await createUser();
    await prisma.tasteProfile.create({ data: { userId: user.id, genres: ["drama"] } });
    tmdbRoutes({ "/movie/7/recommendations": [520], "/discover/movie": [521] });
    const now = new Date("2026-11-15T00:00:00Z");
    const result = await collectCandidates(user.id, { kind: "movie", tmdbId: 7, name: "X" }, now, () => 0);
    expect(result.find((c) => c.tmdbId === 520)!.hints).toEqual(["aehnlich"]);
    expect(result.find((c) => c.tmdbId === 521)!.hints).toEqual(["perlen"]);
    const discover = mockTmdb.mock.calls.find(([p]) => p === "/discover/movie")![1];
    expect(discover["primary_release_date.lte"] <= "2023-11-15").toBe(true);
    expect(discover.with_genres).toBe("18");
  });

  it("caps at 500", async () => {
    const user = await createUser();
    const ids = Array.from({ length: 600 }, (_, i) => 10000 + i);
    await prisma.titleInfo.createMany({
      data: ids.map((tmdbId) => ({ kind: "movie", tmdbId, name: "N", genres: [], overview: "" })),
    });
    mockMdblist.mockResolvedValue(ids.map((tmdb) => ({ tmdb })));
    tmdbRoutes({});
    expect((await collectCandidates(user.id, null)).length).toBe(500);
  });
});
