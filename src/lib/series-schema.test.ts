import { describe, it, expect } from "vitest";
import { prisma } from "../test/setup.js";

async function createShowWithVersion() {
  const show = await prisma.nzbShow.create({
    data: { tmdbId: 95396, titleDe: "Severance", titleEn: "Severance", year: 2022 },
  });
  const episode = await prisma.nzbEpisode.create({
    data: { showId: show.id, season: 2, episode: 5, titleDe: "Trojan's Horse" },
  });
  const file = await prisma.nzbFile.create({
    data: { hash: "a".repeat(64), originalFilename: "x.nzb", episodeId: episode.id },
  });
  return { show, episode, file };
}

describe("series schema", () => {
  it("legt Serie → Folge → Version an und erzwingt eindeutige Folgen", async () => {
    const { show, file } = await createShowWithVersion();
    expect(file.movieId).toBeNull();
    await expect(
      prisma.nzbEpisode.create({ data: { showId: show.id, season: 2, episode: 5 } }),
    ).rejects.toThrow();
  });

  it("löscht Folgen und Versionen mit der Serie (Cascade)", async () => {
    const { show } = await createShowWithVersion();
    await prisma.nzbShow.delete({ where: { id: show.id } });
    expect(await prisma.nzbEpisode.count()).toBe(0);
    expect(await prisma.nzbFile.count()).toBe(0);
  });
});
