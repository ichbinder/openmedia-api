import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import prisma from "../lib/prisma.js";
import { fetchMdblistTitle } from "../lib/mdblist.js";
import { getMeta } from "../lib/meta-service.js";

vi.mock("../lib/mdblist.js", () => ({ fetchMdblistTitle: vi.fn() }));

const fetchMock = vi.mocked(fetchMdblistTitle);
const app = createApp();

const found = (year = 2010) =>
  ({
    status: "found",
    label: "NETFLIX",
    brand: "netflix",
    ratings: { tomatoes: { value: 36, votes: null }, popcorn: { value: 92, votes: null } },
    score: 70,
    year,
  }) as const;

const post = (token: string, items: unknown[]) =>
  request(app).post("/meta").set("Authorization", `Bearer ${token}`).send({ items });

describe("POST /meta", () => {
  let token: string;

  beforeEach(async () => {
    fetchMock.mockReset();
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "meta@test.de", password: "test123", name: "Meta" });
    token = res.body.token;
  });

  it("holt fehlenden Titel und speichert ihn", async () => {
    fetchMock.mockResolvedValue(found());
    const res = await post(token, [{ kind: "movie", tmdbId: 1 }]);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      kind: "movie",
      tmdbId: 1,
      label: "NETFLIX",
      brand: "netflix",
      ratings: { critics: 36, audience: 92 },
      score: 70,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await prisma.titleMeta.count()).toBe(1);
  });

  it("fragt frische Zeile nicht erneut ab", async () => {
    fetchMock.mockResolvedValue(found());
    await post(token, [{ kind: "movie", tmdbId: 1 }]);
    await post(token, [{ kind: "movie", tmdbId: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("liefert veraltete Zeile sofort und frischt im Hintergrund auf", async () => {
    await prisma.titleMeta.create({
      data: {
        kind: "movie",
        tmdbId: 2,
        label: "ALT",
        brand: "other",
        ratings: {},
        year: 2010,
        status: "found",
        fetchedAt: new Date(Date.now() - 8 * 86_400_000),
      },
    });
    fetchMock.mockResolvedValue(found());
    const res = await post(token, [{ kind: "movie", tmdbId: 2 }]);
    expect(res.body.items[0].label).toBe("ALT");
    await vi.waitFor(async () => {
      const row = await prisma.titleMeta.findFirstOrThrow({ where: { tmdbId: 2 } });
      expect(row.label).toBe("NETFLIX");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("begrenzt gleichzeitige Abrufe auf 6", async () => {
    let running = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return found();
    });
    const items = Array.from({ length: 20 }, (_, i) => ({ kind: "movie", tmdbId: 100 + i }));
    const res = await post(token, items);
    expect(res.body.items).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(6);
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("teilt parallele Abrufe desselben Titels", async () => {
    fetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return found();
    });
    const item = [{ kind: "show", tmdbId: 5 }];
    await Promise.all([post(token, item), post(token, item)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("speichert Fehler nicht", async () => {
    fetchMock.mockResolvedValue({ status: "error", reason: "rate_limited" });
    const res = await post(token, [{ kind: "movie", tmdbId: 7 }]);
    expect(res.body.items[0]).toMatchObject({ label: null, brand: null, ratings: {}, score: null });
    expect(await prisma.titleMeta.count()).toBe(0);
    await post(token, [{ kind: "movie", tmdbId: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("speichert not_found und fragt erst am Folgetag erneut", async () => {
    fetchMock.mockResolvedValue({ status: "not_found" });
    const items = [{ kind: "movie" as const, tmdbId: 8 }];
    await getMeta(items);
    await getMeta(items);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await prisma.titleMeta.findFirstOrThrow()).status).toBe("not_found");
    await getMeta(items, new Date(Date.now() + 2 * 86_400_000));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("not_configured liefert leere Werte mit 200", async () => {
    fetchMock.mockResolvedValue({ status: "error", reason: "not_configured" });
    const res = await post(token, [{ kind: "movie", tmdbId: 9 }]);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ label: null, brand: null, ratings: {}, score: null });
  });

  it("verwirft nicht ganzzahlige Jahre", async () => {
    fetchMock.mockResolvedValue({ ...found(), year: 2010.5 });
    const res = await post(token, [{ kind: "movie", tmdbId: 10 }]);
    expect(res.body.items[0].label).toBe("NETFLIX");
    expect((await prisma.titleMeta.findFirstOrThrow()).year).toBeNull();
  });

  it("validiert die Eingabe", async () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ kind: "movie", tmdbId: i + 1 }));
    expect((await post(token, many)).status).toBe(400);
    expect((await post(token, [{ kind: "tv", tmdbId: 1 }])).status).toBe(400);
    expect((await post(token, [{ kind: "movie", tmdbId: 0 }])).status).toBe(400);
    expect((await post(token, [])).status).toBe(400);
    expect((await request(app).post("/meta").send({ items: [] })).status).toBe(401);
  });
});
