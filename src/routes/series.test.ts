import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import fixture from "../lib/__fixtures__/treasure-maps-severance-s02e05.json";

vi.mock("../lib/tmdb.js", () => ({
  getTmdbEpisodeById: vi.fn(),
  getTmdbSeasonById: vi.fn(),
  searchTmdbShowEpisode: vi.fn(),
}));

vi.mock("../lib/treasure-maps.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, searchEpisode: vi.fn(), downloadNzb: vi.fn(), getDownloadBudget: vi.fn() };
});

vi.mock("../lib/episode-requests.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, requestEpisodes: vi.fn() };
});

import { getTmdbEpisodeById } from "../lib/tmdb.js";
import { IndexerError, searchEpisode, toRelease } from "../lib/treasure-maps.js";
import { requestEpisodes, TmdbUnavailableError } from "../lib/episode-requests.js";

const mockEpisode = vi.mocked(getTmdbEpisodeById);
const mockSearch = vi.mocked(searchEpisode);
const mockRequest = vi.mocked(requestEpisodes);
const app = createApp();
const releases = (fixture.items as Parameters<typeof toRelease>[0][]).map(toRelease);
const GUID = "17c315c99a4b4156c247920a62c3f240";
const SECRET = "tm-secret-key-0123456789";

let counter = 0;
async function token() {
  counter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `series-${counter}-${Date.now()}@test.de`, password: "test123", name: "Series User" });
  return res.body.token as string;
}

describe("Serien-Routen", () => {
  let auth: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth = `Bearer ${await token()}`;
  });

  describe("POST /series/requests", () => {
    const post = (body: unknown, header: string | null = auth) => {
      const req = request(app).post("/series/requests");
      return (header ? req.set("Authorization", header) : req).send(body as object);
    };

    it("liefert 401 ohne Token", async () => {
      expect((await post({ tmdbId: 1, season: 1 }, null)).status).toBe(401);
    });

    it.each([
      ["tmdbId fehlt", { season: 1 }],
      ["tmdbId 0", { tmdbId: 0, season: 1 }],
      ["tmdbId Float", { tmdbId: 1.5, season: 1 }],
      ["tmdbId String", { tmdbId: "5", season: 1 }],
      ["season negativ", { tmdbId: 1, season: -1 }],
      ["season Float", { tmdbId: 1, season: 1.2 }],
      ["season String", { tmdbId: 1, season: "1" }],
      ["episode 0", { tmdbId: 1, season: 1, episode: 0 }],
      ["episode Float", { tmdbId: 1, season: 1, episode: 2.5 }],
      ["episode String", { tmdbId: 1, season: 1, episode: "2" }],
      ["guid ohne episode", { tmdbId: 1, season: 1, guid: GUID }],
      ["guid Pfad", { tmdbId: 1, season: 1, episode: 1, guid: "../x" }],
      ["guid Großbuchstaben", { tmdbId: 1, season: 1, episode: 1, guid: GUID.toUpperCase() }],
      ["guid Zahl", { tmdbId: 1, season: 1, episode: 1, guid: 5 }],
    ])("lehnt ab: %s", async (_name, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("reicht gültige Werte durch (season 0 erlaubt)", async () => {
      const views = [{ season: 0, episode: 1, status: "downloading", waitReason: null }];
      mockRequest.mockResolvedValueOnce(views);
      const res = await post({ tmdbId: 95396, season: 0, episode: 1, guid: GUID });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ requests: views });
      expect(mockRequest).toHaveBeenCalledWith(expect.any(String), 95396, 0, 1, GUID);
    });

    it("ganze Staffel ohne episode", async () => {
      mockRequest.mockResolvedValueOnce([]);
      const res = await post({ tmdbId: 95396, season: 2 });
      expect(res.status).toBe(200);
      expect(mockRequest).toHaveBeenCalledWith(expect.any(String), 95396, 2, undefined, undefined);
    });

    it("503 mit reason ohne Indexer-Key", async () => {
      mockRequest.mockRejectedValueOnce(new IndexerError("not_configured"));
      const res = await post({ tmdbId: 1, season: 1, episode: 1 });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Indexer ist nicht eingerichtet.", reason: "indexer_not_configured" });
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it("502 bei Rate-Limit und HTTP-Fehlern des Indexers", async () => {
      mockRequest.mockRejectedValueOnce(new IndexerError("rate_limited", 429));
      const res = await post({ tmdbId: 1, season: 1, episode: 1 });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Indexer gerade nicht erreichbar.", reason: "indexer_error" });
    });

    it("TMDB disabled -> 503, TMDB error -> 502", async () => {
      mockRequest.mockRejectedValueOnce(new TmdbUnavailableError("disabled", "x"));
      const disabled = await post({ tmdbId: 1, season: 1 });
      expect(disabled.status).toBe(503);
      expect(disabled.body).toEqual({
        error: "TMDB-Matching ist nicht verfügbar — Server-Konfiguration fehlt.",
        reason: "tmdb_disabled",
      });
      mockRequest.mockRejectedValueOnce(new TmdbUnavailableError("error", "x"));
      const failed = await post({ tmdbId: 1, season: 1 });
      expect(failed.status).toBe(502);
      expect(failed.body).toEqual({ error: "TMDB gerade nicht erreichbar.", reason: "tmdb_error" });
    });

    it("500 generisch ohne Details, mit Log", async () => {
      mockRequest.mockRejectedValueOnce(new Error(`boom ${SECRET}`));
      const res = await post({ tmdbId: 1, season: 1 });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("GET /series/candidates", () => {
    const get = (query: string, header: string | null = auth) => {
      const req = request(app).get(`/series/candidates${query}`);
      return header ? req.set("Authorization", header) : req;
    };

    it("liefert 401 ohne Token", async () => {
      expect((await get("?tmdbId=1&season=1&episode=1", null)).status).toBe(401);
    });

    it.each([
      "",
      "?tmdbId=1&season=1",
      "?tmdbId=0&season=1&episode=1",
      "?tmdbId=1&season=-1&episode=1",
      "?tmdbId=1&season=1&episode=0",
      "?tmdbId=1.5&season=1&episode=1",
      "?tmdbId=abc&season=1&episode=1",
      "?tmdbId=1&season=1&episode=1&episode=2",
      "?tmdbId=99999999999&season=1&episode=1",
    ])("lehnt ab: %s", async (query) => {
      expect((await get(query)).status).toBe(400);
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it("liefert 12 Kandidaten aus der Fixture, nur freigegebene Felder", async () => {
      mockEpisode.mockResolvedValue({
        status: "found",
        show: {} as never,
        episode: { titleDe: "x", airDate: null, runtime: 50 },
      } as never);
      mockSearch.mockResolvedValue(releases);

      const res = await get("?tmdbId=95396&season=2&episode=5");

      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(12);
      expect(res.body.candidates[0].guid.startsWith("17c315c9")).toBe(true);
      expect(Object.keys(res.body.candidates[0]).sort()).toEqual(
        [
          "audioDescription",
          "germanSubtitles",
          "gbPerHour",
          "guid",
          "inTargetBand",
          "languageSource",
          "qualityTier",
          "releaseType",
          "sizeBytes",
          "title",
        ].sort(),
      );
    });

    it("503 ohne Indexer-Konfiguration, ohne Key in der Antwort", async () => {
      mockEpisode.mockResolvedValue({ status: "not-found" } as never);
      mockSearch.mockRejectedValueOnce(new IndexerError("not_configured"));
      const res = await get("?tmdbId=1&season=1&episode=1");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Indexer ist nicht eingerichtet.", reason: "indexer_not_configured" });
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it("502 bei Indexer-Fehler", async () => {
      mockEpisode.mockResolvedValue({ status: "not-found" } as never);
      mockSearch.mockRejectedValueOnce(new IndexerError("http", 500));
      const res = await get("?tmdbId=1&season=1&episode=1");
      expect(res.status).toBe(502);
      expect(res.body.reason).toBe("indexer_error");
    });
  });
});
