import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Route = { match: string; status?: number; body?: unknown };

function stubFetch(routes: Route[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const route = routes.find((r) => url.includes(r.match));
      const status = route ? (route.status ?? 200) : 404;
      return { ok: status >= 200 && status < 300, status, json: async () => route?.body ?? {} };
    }),
  );
  return calls;
}

async function load(apiKey = "test-key") {
  vi.stubEnv("TMDB_API_KEY", apiKey);
  vi.stubEnv("TMDB_BASE_URL", "http://tmdb.test/3");
  vi.resetModules();
  return (await import("./tmdb.js")).searchTmdbShowEpisode;
}

const showRoutes: Route[] = [
  { match: "/search/tv", body: { results: [{ id: 95396, name: "Severance", original_name: "Severance", poster_path: "/p.jpg" }] } },
  { match: "/tv/95396?api_key=test-key&language=de-DE", body: { name: "Severance DE", overview: "Beschreibung", first_air_date: "2022-02-18", poster_path: "/p.jpg" } },
  { match: "/tv/95396?api_key=test-key&language=en-US", body: { name: "Severance", overview: "Description", first_air_date: "2022-02-18" } },
];

describe("searchTmdbShowEpisode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns show and episode when everything resolves", async () => {
    stubFetch([
      ...showRoutes,
      { match: "/tv/95396/season/2/episode/5", body: { name: "Trojan's Horse", air_date: "2025-02-13" } },
    ]);
    const search = await load();

    const result = await search("Severance", null, 2, 5);

    expect(result).toEqual({
      status: "found",
      show: {
        tmdbId: 95396,
        titleDe: "Severance DE",
        titleEn: "Severance",
        description: "Beschreibung",
        year: 2022,
        posterPath: "/p.jpg",
      },
      episode: { titleDe: "Trojan's Horse", airDate: "2025-02-13" },
    });
  });

  it("returns found with episode null when the episode endpoint 404s", async () => {
    stubFetch(showRoutes);
    const search = await load();

    const result = await search("Severance", null, 2, 5);

    expect(result).toMatchObject({ status: "found", episode: null });
  });

  it("returns error instead of not_found when the show details fail transiently", async () => {
    stubFetch([
      showRoutes[0],
      { match: "/tv/95396?", status: 503 },
    ]);
    const search = await load();

    const result = await search("Severance", null, 2, 5);

    expect(result.status).toBe("error");
  });

  it("returns error instead of episode null when the episode endpoint is rate limited", async () => {
    stubFetch([
      ...showRoutes,
      { match: "/tv/95396/season/2/episode/5", status: 429 },
    ]);
    const search = await load();

    const result = await search("Severance", null, 2, 5);

    expect(result.status).toBe("error");
  });

  it("returns not_found when the search has no results", async () => {
    stubFetch([{ match: "/search/tv", body: { results: [] } }]);
    const search = await load();

    expect(await search("Nope", null, 1, 1)).toEqual({ status: "not_found" });
  });

  it("returns error on rate limit", async () => {
    stubFetch([{ match: "/search/tv", status: 429 }]);
    const search = await load();

    expect(await search("Severance", null, 1, 1)).toMatchObject({ status: "error" });
  });

  it("returns disabled without an API key", async () => {
    const calls = stubFetch([]);
    const search = await load("");

    expect(await search("Severance", null, 1, 1)).toMatchObject({ status: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("passes year as first_air_date_year", async () => {
    const calls = stubFetch([{ match: "/search/tv", body: { results: [] } }]);
    const search = await load();

    await search("Severance", 2022, 1, 1);

    expect(calls[0]).toContain("first_air_date_year=2022");
  });
});
