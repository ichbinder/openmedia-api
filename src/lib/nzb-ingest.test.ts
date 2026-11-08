import { describe, it, expect, vi } from "vitest";
import { prisma } from "../test/setup.js";
import { ingestNzb, type IngestResolution } from "./nzb-ingest.js";

vi.mock("./nzb-service.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, storeNzbInService: vi.fn().mockResolvedValue(undefined) };
});

const nzbContent = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="a@b.c" date="1" subject="ingest [1/1] &quot;x.rar&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="1" number="1">ingest@test.com</segment></segments>
  </file>
</nzb>`;

const episodeResolution: IngestResolution = {
  source: "tmdb-found",
  show: { tmdbId: 95396, titleDe: "Severance", titleEn: "Severance", description: "", year: 2022, posterPath: null },
  season: 2,
  episode: 5,
  tmdbEpisode: { titleDe: "Folge 5", airDate: null, runtime: null },
};

const fileData = {
  indexerGuid: "guid-123",
  qualityTier: "1080p",
  resolution: "1080p",
  fileSize: 4_000_000_000n,
  audioLanguages: ["de", "en"],
  subtitleLanguages: ["de"],
  releaseType: "WEB-DL",
};

function ingest(withFileData = true) {
  const resolve = vi.fn().mockResolvedValue(episodeResolution);
  const result = ingestNzb({
    nzbContent,
    title: "Severance",
    filename: "Severance.S02E05.German.DL.720p.WEB.x264-FuN.nzb",
    userId: null,
    resolve,
    ...(withFileData && { fileData }),
  });
  return { result, resolve };
}

describe("ingestNzb", () => {
  it("legt mit Folge und fileData eine NzbFile an, ein zweiter Aufruf liefert conflict", async () => {
    const first = await ingest().result;

    expect(first.kind).toBe("created");
    const file = await prisma.nzbFile.findFirstOrThrow();
    const episode = await prisma.nzbEpisode.findFirstOrThrow();
    expect(file).toMatchObject({
      episodeId: episode.id,
      indexerGuid: "guid-123",
      qualityTier: "1080p",
      resolution: "1080p",
      fileSize: 4_000_000_000n,
      subtitleLanguages: ["de"],
      releaseType: "WEB-DL",
    });
    expect(episode).toMatchObject({ season: 2, episode: 5 });

    const { result, resolve } = ingest();
    expect((await result).kind).toBe("conflict");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("trägt bei bekannter NzbFile ohne indexerGuid die GUID nach", async () => {
    await ingest(false).result;
    expect((await prisma.nzbFile.findFirstOrThrow()).indexerGuid).toBeNull();

    expect((await ingest().result).kind).toBe("conflict");
    expect((await prisma.nzbFile.findFirstOrThrow()).indexerGuid).toBe("guid-123");
  });
});
