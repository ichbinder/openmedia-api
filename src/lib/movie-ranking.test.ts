import { describe, expect, it, vi } from "vitest";
import type { IndexerRelease } from "./treasure-maps.js";

vi.mock("./config-service.js", () => ({ getEntry: vi.fn() }));

import { rankMovieCandidates, type OwnFile } from "./movie-ranking.js";

const opts = { runtimeMinutes: 120, band: { min: 1.5, max: 6 } };

function release(over: Partial<IndexerRelease>): IndexerRelease {
  return {
    guid: "g",
    title: "Film.2024.German.DL.1080p.WEB.x264-GRP",
    size: 3e9,
    postedAt: "2025-01-01",
    password: 0,
    season: null,
    episode: null,
    audioLanguages: ["German"],
    subtitles: null,
    videoWidth: 1920,
    ...over,
  };
}

function file(over: Partial<OwnFile>): OwnFile {
  return {
    id: "f1",
    hash: "abcdef1234567890",
    originalFilename: "Film.2024.German.1080p.WEB.mkv",
    fileSize: BigInt(3e9),
    qualityTier: "1080p",
    videoWidth: null,
    audioLanguages: [],
    subtitleLanguages: [],
    releaseType: null,
    indexerGuid: null,
    status: "available",
    brokenReason: null,
    failedAttempts: 0,
    s3Key: null,
    mediaInfo: null,
    ...over,
  };
}

const keys = (r: ReturnType<typeof rankMovieCandidates>) => r.map((c) => c.key);

describe("rankMovieCandidates", () => {
  it("German 720p beats English 1080p", () => {
    const r = rankMovieCandidates(
      [
        release({
          guid: "en1080",
          audioLanguages: ["English"],
          videoWidth: 1920,
        }),
        release({ guid: "de720", videoWidth: 1280 }),
      ],
      [],
      opts,
    );
    expect(keys(r)).toEqual(["guid:de720", "guid:en1080"]);
  });

  it("cam goes after foreign; German cam before English cam", () => {
    const r = rankMovieCandidates(
      [
        release({
          guid: "de-ts",
          title: "Film.German.TS.1080p",
          audioLanguages: null,
        }),
        release({
          guid: "en-web",
          title: "Film.English.1080p.WEB",
          audioLanguages: ["English"],
        }),
        release({
          guid: "en-cam",
          title: "Film.English.CAM",
          audioLanguages: ["English"],
        }),
      ],
      [],
      opts,
    );
    expect(keys(r)).toEqual(["guid:en-web", "guid:de-ts", "guid:en-cam"]);
    expect(r.map((c) => c.group)).toEqual(["foreign", "cam", "cam"]);
  });

  it("tie in group, tier and bonus: ready file beats bigger indexer hit", () => {
    const r = rankMovieCandidates(
      [release({ guid: "hit", size: 10e9 })],
      [file({ id: "a", fileSize: BigInt(6e9), s3Key: "k", status: "ready" })],
      opts,
    );
    expect(keys(r)).toEqual(["file:a", "guid:hit"]);
    expect(r[0].state).toBe("ready");
  });

  it("bigger tier still beats a ready file", () => {
    const r = rankMovieCandidates(
      [release({ guid: "hit", size: 5e9 })],
      [
        file({
          id: "a",
          qualityTier: "720p",
          s3Key: "k",
          fileSize: BigInt(2e9),
        }),
      ],
      opts,
    );
    expect(keys(r)).toEqual(["guid:hit", "file:a"]);
  });

  it("drops the indexer hit that an own file already represents", () => {
    const r = rankMovieCandidates(
      [release({ guid: "x" })],
      [file({ id: "a", indexerGuid: "x" })],
      opts,
    );
    expect(keys(r)).toEqual(["file:a"]);
  });

  it("drops password-protected releases and files with 3 failures", () => {
    const r = rankMovieCandidates(
      [
        release({ guid: "pw", password: 2 }),
        release({ guid: "nosize", size: 0 }),
      ],
      [file({ id: "a", failedAttempts: 3 })],
      opts,
    );
    expect(r).toEqual([]);
  });

  it("broken own file is listed last with state broken even when on S3", () => {
    const r = rankMovieCandidates(
      [release({ guid: "en", audioLanguages: ["English"], videoWidth: 1280 })],
      [file({ id: "a", status: "broken", s3Key: "k", brokenReason: "bad" })],
      opts,
    );
    expect(keys(r)).toEqual(["guid:en", "file:a"]);
    expect(r[1].state).toBe("broken");
    expect(r[1].brokenReason).toBe("bad");
    expect(r[1].hashPrefix).toBe("abcdef12");
  });

  it("own file without language hint and without mediaInfo is foreign with no languages", () => {
    const [c] = rankMovieCandidates(
      [],
      [file({ originalFilename: "Film.2024.1080p.WEB.mkv", mediaInfo: null })],
      opts,
    );
    expect(c.group).toBe("foreign");
    expect(c.audioLanguages).toEqual([]);
  });

  it("uses ffprobe languages for own files with mediaInfo", () => {
    const [c] = rankMovieCandidates(
      [],
      [
        file({
          originalFilename: "Film.mkv",
          mediaInfo: {},
          audioLanguages: ["ger", "eng"],
        }),
      ],
      opts,
    );
    expect(c.group).toBe("german");
    expect(c.audioLanguages).toEqual(["de", "en"]);
  });

  it("DTS in a title is not a cam release", () => {
    const [c] = rankMovieCandidates(
      [release({ title: "Film.German.DTS.1080p.BluRay" })],
      [],
      opts,
    );
    expect(c.group).toBe("german");
  });
});
