import { describe, it, expect } from "vitest";
import { originLabel, storedRatings, toRatings, isStale } from "./title-meta.js";

describe("originLabel", () => {
  it.each([
    ["HBO", "HBO", "hbo"],
    ["Apple TV", "APPLE TV+", "apple"],
    ["Netflix", "NETFLIX", "netflix"],
    ["Disney+", "DISNEY+", "disney"],
    ["Max", "HBO", "hbo"],
    ["Sky Atlantic", "SKY", "sky"],
    ["BBC One", "BBC ONE", "other"],
  ])("show network %s", (network, label, brand) => {
    expect(originLabel("show", { network })).toEqual({ label, brand });
  });

  it("returns null without network", () => {
    expect(originLabel("show", { network: null })).toBeNull();
  });

  it.each([
    ["Netflix", "NETFLIX", "netflix"],
    ["Amazon Prime Video", "PRIME VIDEO", "prime"],
    ["Disney+, Disney +", "DISNEY+", "disney"],
    ["Paramount Plus", "PARAMOUNT+", "paramount"],
    [null, "KINO", "cinema"],
    ["", "KINO", "cinema"],
    ["TVOD", "KINO", "cinema"],
    ["tvod", "KINO", "cinema"],
    ["Hulu", "HULU", "other"],
  ])("movie digitalDetail %s", (digitalDetail, label, brand) => {
    expect(originLabel("movie", { digitalDetail })).toEqual({ label, brand });
  });
});

describe("ratings", () => {
  it("storedRatings drops null values", () => {
    expect(
      storedRatings([
        { source: "tomatoes", value: 36, votes: 174 },
        { source: "rogerebert", value: null },
      ]),
    ).toEqual({ tomatoes: { value: 36, votes: 174 } });
  });

  it("toRatings maps known sources only", () => {
    const v = (value: number) => ({ value, votes: 1 });
    expect(
      toRatings({ tomatoes: v(36), popcorn: v(92), imdb: v(6.3), metacriticuser: v(5.9) }),
    ).toEqual({ critics: 36, audience: 92, imdb: 6.3 });
  });
});

describe("isStale", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it("uses 7 days for old titles", () => {
    expect(isStale({ status: "found", year: 2010, fetchedAt: ago(6) }, now)).toBe(false);
    expect(isStale({ status: "found", year: 2010, fetchedAt: ago(8) }, now)).toBe(true);
  });
  it("uses 1 day for fresh titles", () => {
    expect(isStale({ status: "found", year: 2025, fetchedAt: ago(2) }, now)).toBe(true);
  });
  it("uses 1 day for not_found", () => {
    expect(isStale({ status: "not_found", year: 2010, fetchedAt: ago(2) }, now)).toBe(true);
  });
  it("treats unknown year as old", () => {
    expect(isStale({ status: "found", year: null, fetchedAt: ago(6) }, now)).toBe(false);
  });
});
