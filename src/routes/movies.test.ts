import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

vi.mock("../lib/movie-requests.js", () => ({
  listMovieCandidates: vi.fn(),
  requestMovie: vi.fn(),
}));

import { listMovieCandidates, requestMovie } from "../lib/movie-requests.js";
import { IndexerError } from "../lib/treasure-maps.js";

const mockList = vi.mocked(listMovieCandidates);
const mockRequest = vi.mocked(requestMovie);
const app = createApp();
const FILE_KEY = "file:123e4567-e89b-12d3-a456-426614174000";
const GUID_KEY = "guid:17c315c99a4b4156c247920a62c3f240";

let counter = 0;
async function token() {
  counter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `movies-${counter}-${Date.now()}@test.de`, password: "test123", name: "Movie User" });
  return res.body.token as string;
}

describe("Film-Routen", () => {
  let auth: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    auth = `Bearer ${await token()}`;
  });

  describe("GET /movies/candidates", () => {
    const get = (query: string) => request(app).get(`/movies/candidates${query}`).set("Authorization", auth);

    it("liefert eigene Dateien auch ohne eingerichteten Indexer", async () => {
      mockList.mockResolvedValue({ candidates: [], indexer: "unavailable" });
      const res = await get("?tmdbId=603");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ candidates: [], indexer: "unavailable" });
      expect(mockList).toHaveBeenCalledWith(603);
    });

    it("lehnt eine ungültige tmdbId mit 400 ab", async () => {
      expect((await get("?tmdbId=abc")).status).toBe(400);
      expect((await get("")).status).toBe(400);
      expect(mockList).not.toHaveBeenCalled();
    });
  });

  describe("POST /movies/requests", () => {
    const post = (body: unknown, header: string | null = auth) => {
      const req = request(app).post("/movies/requests");
      return (header ? req.set("Authorization", header) : req).send(body as object);
    };

    it("liefert 401 ohne Token", async () => {
      expect((await post({ tmdbId: 603, key: FILE_KEY }, null)).status).toBe(401);
    });

    it("liefert 200 mit Status und nzbFileId", async () => {
      mockRequest.mockResolvedValue({ status: "downloading", nzbFileId: "nzb-1" });
      const res = await post({ tmdbId: 603, key: GUID_KEY, confirmed: true, manual: "yes" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "downloading", nzbFileId: "nzb-1" });
      expect(mockRequest).toHaveBeenCalledWith(expect.any(String), 603, GUID_KEY, { confirmed: true, manual: false });
    });

    it("bildet confirm_required auf 409 ab", async () => {
      mockRequest.mockResolvedValue({ status: "confirm_required", group: "cam" });
      const res = await post({ tmdbId: 603, key: GUID_KEY });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ reason: "confirm_required", group: "cam" });
    });

    it("bildet budget auf 429 mit deutschem Text ab", async () => {
      mockRequest.mockResolvedValue({ status: "budget" });
      const res = await post({ tmdbId: 603, key: GUID_KEY });
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ reason: "budget", error: "Tageslimit erreicht — morgen wieder" });
    });

    it("bildet candidate_gone auf 404 ab", async () => {
      mockRequest.mockResolvedValue({ status: "candidate_gone" });
      const res = await post({ tmdbId: 603, key: GUID_KEY });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ reason: "candidate_gone", error: "Version nicht mehr verfügbar" });
    });

    it("bildet failed auf 409 ab", async () => {
      mockRequest.mockResolvedValue({ status: "failed" });
      const res = await post({ tmdbId: 603, key: GUID_KEY });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ reason: "failed", error: "Keine passende Version konnte geladen werden" });
    });

    it("lehnt einen fehlerhaften key mit 400 ab", async () => {
      expect((await post({ tmdbId: 603, key: "guid:xyz" })).status).toBe(400);
      expect((await post({ tmdbId: 603 })).status).toBe(400);
      expect((await post({ tmdbId: 0, key: GUID_KEY })).status).toBe(400);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("meldet Indexer-Fehler als 502", async () => {
      mockRequest.mockRejectedValue(new IndexerError("http", 500));
      const res = await post({ tmdbId: 603, key: GUID_KEY });
      expect(res.status).toBe(502);
      expect(res.body.reason).toBe("indexer_error");
    });
  });
});
