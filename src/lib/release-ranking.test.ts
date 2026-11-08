import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/treasure-maps-severance-s02e05.json";
import { toRelease, type IndexerRelease } from "./treasure-maps.js";

const getEntry = vi.fn();
vi.mock("./config-service.js", () => ({ getEntry: (...a: unknown[]) => getEntry(...a) }));

import { getTargetBand, rankReleases } from "./release-ranking.js";

const opts = { season: 2, episode: 5, runtimeMinutes: 50, band: { min: 1.5, max: 6 } };
const releases = (fixture.items as Parameters<typeof toRelease>[0][]).map(toRelease);

function release(over: Partial<IndexerRelease>): IndexerRelease {
  return {
    guid: "g",
    title: "Show.S02E05.German.DL.1080p.WEB.x264-GRP",
    size: 3e9,
    postedAt: "2025-01-01",
    password: 0,
    season: 2,
    episode: 5,
    audioLanguages: ["German"],
    subtitles: null,
    videoWidth: 1920,
    ...over,
  };
}

describe("rankReleases with the Severance fixture", () => {
  const ranked = rankReleases(releases, opts);

  it("keeps 12 releases and orders the top four", () => {
    expect(ranked).toHaveLength(12);
    expect(ranked.slice(0, 4).map((r) => r.guid.slice(0, 8))).toEqual(["17c315c9", "73af81be", "eaa01ef2", "41167b5c"]);
  });

  it("drops twins without data", () => {
    const guids = ranked.map((r) => r.guid.slice(0, 8));
    for (const g of ["25f4bc84", "2da553c3", "38974f14", "3e1f89d0", "8562c9c2", "6f950338", "fc25c9b5", "cc6e62d6"]) {
      expect(guids).not.toContain(g);
    }
  });

  it("puts 480p last and flags language source", () => {
    expect(ranked.slice(-2).map((r) => r.qualityTier)).toEqual(["480p", "480p"]);
    expect(ranked.find((r) => r.guid.startsWith("eaa01ef2"))?.languageSource).toBe("name");
    expect(ranked[0].languageSource).toBe("mediainfo");
  });
});

describe("rankReleases rules", () => {
  it("drops non-German audio", () => {
    expect(rankReleases([release({ audioLanguages: ["English"] })], opts)).toEqual([]);
  });

  it("drops no-data releases without German/DL in the name", () => {
    const r = release({ title: "Show.S02E05.1080p.WEB.x264-GRP", audioLanguages: null });
    expect(rankReleases([r], opts)).toEqual([]);
  });

  it("drops a no-data twin even if it is bigger", () => {
    const withData = release({ guid: "a", size: 2e9 });
    const noData = release({ guid: "b", title: withData.title.toUpperCase(), size: 5e9, audioLanguages: null });
    expect(rankReleases([noData, withData], opts).map((r) => r.guid)).toEqual(["a"]);
  });

  it("drops password 2 and wrong episode or season packs", () => {
    expect(rankReleases([release({ password: 2 })], opts)).toEqual([]);
    expect(rankReleases([release({ episode: 6 })], opts)).toEqual([]);
    expect(rankReleases([release({ episode: null })], opts)).toEqual([]);
  });

  it("returns a lone SD release", () => {
    const r = release({ videoWidth: 720, title: "Show.S02E05.German.DL.x264-GRP" });
    const out = rankReleases([r], opts);
    expect(out).toHaveLength(1);
    expect(out[0].qualityTier).toBe("480p");
  });

  it("does not treat WEB-DL as a German hint", () => {
    const noData = { audioLanguages: null };
    expect(rankReleases([release({ ...noData, title: "Show.S02E05.1080p.WEB-DL.x264-GRP" })], opts)).toEqual([]);
    expect(rankReleases([release({ ...noData, title: "Show.S02E05.German.DL.1080p.WEB-DL.x264-GRP" })], opts)).toHaveLength(1);
    expect(rankReleases([release({ ...noData, title: "Show.S02E05.DL.1080p.WEB.x264-GRP" })], opts)).toHaveLength(1);
  });

  it("treats gbPerHour exactly at max as in band", () => {
    const out = rankReleases([release({ size: 5e9 })], { ...opts, band: { min: 1.5, max: 6 }, runtimeMinutes: 50 });
    expect(out[0].gbPerHour).toBeCloseTo(6);
    const exact = rankReleases([release({ size: 6e9 })], { ...opts, runtimeMinutes: 60 });
    expect(exact[0].inTargetBand).toBe(true);
  });

  it("ranks 2160p below out-of-band 1080p and above 720p", () => {
    const hd = release({ guid: "hd", size: 0.5e9 });
    const uhd = release({ guid: "uhd", videoWidth: 3840, size: 10e9 });
    const p720 = release({ guid: "p720", videoWidth: 1280, size: 2e9 });
    expect(rankReleases([p720, uhd, hd], opts).map((r) => r.guid)).toEqual(["hd", "uhd", "p720"]);
  });

  it("falls back to 45 minutes for invalid runtime", () => {
    expect(rankReleases([release({ size: 3e9 })], { ...opts, runtimeMinutes: 0 })[0].gbPerHour).toBeCloseTo(4);
  });

  it("falls back to the title resolution without width", () => {
    const r = release({ videoWidth: null, title: "Show.S02E05.German.DL.720p.WEB-GRP", audioLanguages: null });
    expect(rankReleases([r], opts)[0].qualityTier).toBe("720p");
  });

  it("lets bonus beat size inside the band", () => {
    const big = release({ guid: "big", size: 4e9 });
    const small = release({
      guid: "small",
      size: 2.5e9,
      subtitles: ["German"],
      title: "Show.S02E05.German.DL.Hoerfilm.1080p.WEB.x264-GRP",
    });
    const out = rankReleases([big, small], opts);
    expect(out.map((r) => r.guid)).toEqual(["small", "big"]);
    expect(out[0]).toMatchObject({ germanSubtitles: true, audioDescription: true, inTargetBand: true });
  });

  it("orders other tiers by distance to the band", () => {
    const far = release({ guid: "far", videoWidth: 1280, size: 0.2e9 });
    const near = release({ guid: "near", videoWidth: 1280, size: 1e9 });
    expect(rankReleases([far, near], opts).map((r) => r.guid)).toEqual(["near", "far"]);
  });
});

describe("getTargetBand", () => {
  beforeEach(() => getEntry.mockReset());

  it("uses defaults when missing or invalid", async () => {
    getEntry.mockResolvedValue(null);
    expect(await getTargetBand()).toEqual({ min: 1.5, max: 6 });
    getEntry.mockResolvedValue({ value: "abc" });
    expect(await getTargetBand()).toEqual({ min: 1.5, max: 6 });
    getEntry.mockResolvedValue({ value: "-2" });
    expect(await getTargetBand()).toEqual({ min: 1.5, max: 6 });
  });

  it("falls back when min >= max", async () => {
    getEntry.mockImplementation(async (_c: string, key: string) => ({ value: key === "targetGbPerHourMin" ? "8" : "2" }));
    expect(await getTargetBand()).toEqual({ min: 1.5, max: 6 });
  });

  it("reads configured values", async () => {
    getEntry.mockImplementation(async (_c: string, key: string) => ({ value: key === "targetGbPerHourMin" ? "2" : "8" }));
    expect(await getTargetBand()).toEqual({ min: 2, max: 8 });
  });
});
