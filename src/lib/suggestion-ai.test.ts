import { describe, it, expect } from "vitest";
import { buildMessages, parseSuggestions, HARD_EXCLUSION_RULE } from "./suggestion-ai.js";
import type { Candidate, Hint } from "./candidates.js";
import type { TasteView } from "./taste-service.js";

const now = new Date("2026-06-01T00:00:00Z");

const candidate = (kind: "movie" | "show", tmdbId: number, hints: Hint[], year = 2025): Candidate => ({
  kind, tmdbId, name: `T${tmdbId}`, year, genres: ["Drama"], overview: "x", posterPath: null,
  hints, label: null, critics: null, audience: null,
});

const taste: TasteView = {
  exists: true,
  persons: [
    { id: "1", name: "Anna", limits: ["horror"], limitsText: "keine Spinnen" },
    { id: "2", name: "Ben", limits: [], limitsText: "kein Krieg" },
  ],
  genres: ["drama"], likesText: "Krimis", traktImportedAt: null, traktImportCounts: null,
};

const base = { taste, rated: [], seen: [], dismissed: [], candidates: [candidate("movie", 1, ["neu"])], because: null, now };
const text = (m: ReturnType<typeof buildMessages>) => m.map((x) => x.content).join("\n");

describe("buildMessages", () => {
  it("contains persons, limit texts, exclusion rule and candidate with hint", () => {
    const t = text(buildMessages(base));
    for (const s of ["Anna", "Ben", "keine Spinnen", "kein Krieg", HARD_EXCLUSION_RULE, "movie-1"]) expect(t).toContain(s);
    expect(t).toMatch(/movie-1[^\n]*neu/);
  });

  it("renders limit keys as German labels", () => {
    const person = { id: "3", name: "Cleo", limits: ["gewalt_selbstzweck", "sex_hauptinhalt"], limitsText: "" };
    const t = text(buildMessages({ ...base, taste: { ...taste, persons: [person] } }));
    expect(t).toContain("Gewalt als Selbstzweck");
    expect(t).toContain("Sex als Hauptinhalt");
    expect(t).not.toContain("gewalt_selbstzweck");
  });

  it("caps ratings at 150", () => {
    const rated = Array.from({ length: 200 }, (_, i) => ({ name: `R${i}X`, year: 2020, verdict: "up" as const, tags: [] }));
    const t = text(buildMessages({ ...base, rated }));
    expect(t).toContain("R149X");
    expect(t).not.toContain("R150X");
  });
});

describe("parseSuggestions", () => {
  const rows = (r: object) => ({ rows: r });
  const e = (id: string, reason = "gut") => ({ id, reason });

  it("drops unknown ids", () => {
    expect(parseSuggestions(rows({ neu: [e("movie-9")] }), [candidate("movie", 1, ["neu"])], now)).toEqual([]);
  });

  it("keeps duplicates only in first row", () => {
    const c = candidate("movie", 1, ["neu"], 2015);
    const out = parseSuggestions(rows({ neu: [e("movie-1")], perlen: [e("movie-1")] }), [c], now);
    expect(out.map((r) => r.row)).toEqual(["neu"]);
  });

  it("drops movies from serien", () => {
    expect(parseSuggestions(rows({ serien: [e("movie-1")] }), [candidate("movie", 1, ["serien"])], now)).toEqual([]);
  });

  it("drops too-young titles from perlen", () => {
    expect(parseSuggestions(rows({ perlen: [e("movie-1")] }), [candidate("movie", 1, ["perlen"], 2024)], now)).toEqual([]);
  });

  it("requires matching hint for neu", () => {
    expect(parseSuggestions(rows({ neu: [e("movie-1")] }), [candidate("movie", 1, ["aehnlich"])], now)).toEqual([]);
  });

  it("truncates reasons to 90 chars with ellipsis and drops empty ones", () => {
    const c = [candidate("movie", 1, ["neu"]), candidate("movie", 2, ["neu"])];
    const out = parseSuggestions(rows({ neu: [e("movie-1", "a".repeat(120)), e("movie-2", "  ")] }), c, now);
    expect(out[0].items).toHaveLength(1);
    expect(out[0].items[0].reason).toBe("a".repeat(89) + "…");
  });

  it("caps rows at 50", () => {
    const c = Array.from({ length: 60 }, (_, i) => candidate("movie", i + 1, ["neu"]));
    const out = parseSuggestions(rows({ neu: c.map((x) => e(`movie-${x.tmdbId}`)) }), c, now);
    expect(out[0].items).toHaveLength(50);
  });

  it("returns [] for broken shape", () => {
    expect(parseSuggestions({ rows: "x" }, [], now)).toEqual([]);
    expect(parseSuggestions(null, [], now)).toEqual([]);
  });
});
