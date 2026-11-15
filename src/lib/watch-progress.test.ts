import { describe, it, expect } from "vitest";
import { isFinishedPosition, titleState, resumePosition, pickStreamableFile } from "./watch-progress.js";

describe("isFinishedPosition", () => {
  it("is finished from 90 percent", () => {
    expect(isFinishedPosition(5400, 6000)).toBe(true);
    expect(isFinishedPosition(5399, 6000)).toBe(false);
  });
});

describe("titleState", () => {
  const state = (positionSec: number, finishedAt: Date | null) => titleState({ positionSec, durationSec: 6000, finishedAt });

  it("is started above 60 s and below 90 percent", () => {
    expect(state(61, null)).toBe("started");
    expect(state(60, null)).toBe("new");
  });

  it("counts finished only via finishedAt", () => {
    expect(state(5500, null)).toBe("new");
    expect(state(5500, new Date())).toBe("finished");
    expect(state(30, new Date())).toBe("finished");
  });

  it("is started again when rewatching after finishing", () => {
    expect(state(120, new Date())).toBe("started");
  });
});

describe("resumePosition", () => {
  const saved = { positionSec: 3000, durationSec: 6000 };

  it("rewinds 5 s when length is within tolerance", () => {
    expect(resumePosition(saved, 6060)).toBe(2995);
    expect(resumePosition(saved, null)).toBe(2995);
  });

  it("scales proportionally for a different length", () => {
    expect(resumePosition(saved, 7200)).toBe(3595);
  });

  it("never goes negative", () => {
    expect(resumePosition({ positionSec: 3, durationSec: 6000 }, 6000)).toBe(0);
  });
});

describe("pickStreamableFile", () => {
  const file = (over: Partial<Parameters<typeof pickStreamableFile>[0][number]>) => ({
    s3StreamKey: "k", status: "ok", qualityTier: "1080p", resolution: null, fileSize: 1n, ...over,
  });

  it("ignores files without stream key and broken files", () => {
    const good = file({});
    expect(pickStreamableFile([file({ s3StreamKey: null, qualityTier: "2160p" }), file({ status: "broken", qualityTier: "2160p" }), good])).toBe(good);
  });

  it("prefers 2160p over 1080p, then larger size", () => {
    const uhd = file({ qualityTier: "2160p" });
    expect(pickStreamableFile([file({}), uhd])).toBe(uhd);
    const big = file({ fileSize: 9n });
    expect(pickStreamableFile([file({}), big])).toBe(big);
  });

  it("falls back to resolution", () => {
    const uhd = file({ qualityTier: null, resolution: "2160p" });
    expect(pickStreamableFile([file({}), uhd])).toBe(uhd);
  });

  it("returns undefined for an empty list", () => {
    expect(pickStreamableFile([])).toBeUndefined();
  });
});
