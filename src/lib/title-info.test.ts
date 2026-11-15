import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../test/setup.js";

vi.mock("./tmdb.js", () => ({ tmdbGet: vi.fn() }));

import { tmdbGet } from "./tmdb.js";
import { getTitleInfos } from "./title-info.js";

const mockGet = vi.mocked(tmdbGet);
const DAY = 24 * 60 * 60 * 1000;

describe("getTitleInfos", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("caches for 30 days and refetches after 31", async () => {
    mockGet.mockResolvedValue({
      title: "Heat",
      release_date: "1995-12-15",
      genres: [{ name: "Krimi" }],
      overview: "x".repeat(300),
      poster_path: "/h.jpg",
    });
    const start = new Date();
    const first = await getTitleInfos([{ kind: "movie", tmdbId: 9001 }], start);
    expect(first.get("movie-9001")).toMatchObject({ name: "Heat", year: 1995, genres: ["Krimi"], posterPath: "/h.jpg" });
    expect(first.get("movie-9001")!.overview).toHaveLength(200);

    await getTitleInfos([{ kind: "movie", tmdbId: 9001 }], new Date(start.getTime() + 29 * DAY));
    expect(mockGet).toHaveBeenCalledTimes(1);

    await getTitleInfos([{ kind: "movie", tmdbId: 9001 }], new Date(start.getTime() + 31 * DAY));
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it("leaves unknown titles out of the map", async () => {
    mockGet.mockResolvedValue(null);
    const result = await getTitleInfos([{ kind: "show", tmdbId: 9002 }]);
    expect(result.size).toBe(0);
    expect(await prisma.titleInfo.count({ where: { tmdbId: 9002 } })).toBe(0);
  });
});
