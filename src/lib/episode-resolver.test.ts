import { describe, it, expect } from "vitest";
import { prisma } from "../test/setup.js";
import { upsertEpisode } from "./episode-resolver.js";

const show = {
  tmdbId: 95396,
  titleDe: "Severance",
  titleEn: "Severance",
  description: "",
  year: 2022,
  posterPath: null,
};

describe("upsertEpisode", () => {
  it("legt bei gleichzeitigen Anfragen derselben neuen Serie genau eine Serie an", async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map((episode) =>
        prisma.$transaction((tx) => upsertEpisode(tx, show, 1, episode, { titleDe: `Folge ${episode}`, airDate: null, runtime: null })),
      ),
    );

    expect(new Set(ids).size).toBe(4);
    expect(await prisma.nzbShow.count()).toBe(1);
    expect(await prisma.nzbEpisode.count()).toBe(4);
  });

  it("liefert für dieselbe Folge immer dieselbe ID", async () => {
    const [a, b] = await Promise.all(
      [0, 1].map(() => prisma.$transaction((tx) => upsertEpisode(tx, show, 2, 5, null))),
    );

    expect(a).toBe(b);
    expect(await prisma.nzbEpisode.count()).toBe(1);
  });
});
