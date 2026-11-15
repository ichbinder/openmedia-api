import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { chatJson } from "../lib/openrouter.js";
import { collectCandidates } from "../lib/candidates.js";
import { runSuggestions } from "../lib/suggestion-run.js";
import prisma from "../lib/prisma.js";
import type { Candidate } from "../lib/candidates.js";

process.env.ENCRYPTION_MASTER_KEY ||= "a".repeat(64);

vi.mock("../lib/openrouter.js", () => ({ chatJson: vi.fn() }));
vi.mock("../lib/candidates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/candidates.js")>()),
  collectCandidates: vi.fn(),
}));


const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const KEY = "sk-secret-key";

const candidate = (tmdbId: number, kind: "movie" | "show" = "movie"): Candidate => ({
  kind, tmdbId, name: `Titel ${tmdbId}`, year: 2026, genres: [], overview: "", posterPath: `/p${tmdbId}.jpg`,
  hints: ["neu"], label: null, critics: null, audience: null,
});

const answer = (ids: string[]) => ({
  ok: true as const,
  json: { rows: { neu: ids.map((id) => ({ id, reason: "Passt gut." })) } },
});

describe("/suggestions", () => {
  let token: string;
  let userId: string;

  const get = () => request(app).get("/suggestions").set(auth(token));
  const refresh = () => request(app).post("/suggestions/refresh").set(auth(token));
  const names = (body: any) => body.rows.flatMap((r: any) => r.items.map((i: any) => i.tmdbId));

  const seedInfos = (ids: number[]) =>
    prisma.titleInfo.createMany({
      data: ids.map((tmdbId) => ({ kind: "movie", tmdbId, name: `Titel ${tmdbId}`, year: 2026, overview: "", posterPath: `/p${tmdbId}.jpg` })),
    });

  beforeEach(async () => {
    vi.mocked(chatJson).mockReset();
    vi.mocked(collectCandidates).mockReset();
    const res = await request(app).post("/auth/register").send({ email: "s@test.de", password: "test123", name: "T" });
    token = res.body.token;
    userId = res.body.user.id;
    await request(app).put("/ai-settings").set(auth(token)).send({ model: "m", apiKey: KEY });
    vi.mocked(collectCandidates).mockResolvedValue([candidate(1), candidate(2), candidate(3)]);
    await seedInfos([1, 2, 3, 4]);
  });

  it("ohne Token: 401", async () => {
    expect((await request(app).get("/suggestions")).status).toBe(401);
  });

  it("ohne Key: no_key", async () => {
    await request(app).put("/ai-settings").set(auth(token)).send({ model: "m", apiKey: "" });
    expect((await get()).body).toMatchObject({ status: "no_key", rows: [], running: false });
  });

  it("ohne Lauf: none", async () => {
    expect((await get()).body).toMatchObject({ status: "none", createdAt: null, rows: [] });
  });

  it("Erfolg speichert Reihen und ersetzt den alten Lauf", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1", "movie-2"]));
    expect(await runSuggestions(userId)).toBe("done");
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-3"]));
    expect(await runSuggestions(userId)).toBe("done");

    const res = await get();
    expect(res.body.status).toBe("ready");
    expect(res.body.rows).toEqual([
      {
        key: "neu",
        title: "Neu für euch",
        items: [{ kind: "movie", tmdbId: 3, name: "Titel 3", year: 2026, posterPath: "/p3.jpg", reason: "Passt gut." }],
      },
    ]);
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
    expect(await prisma.suggestion.count()).toBe(1);
  });

  it("aehnlich trägt den Namen des Ausgangstitels", async () => {
    await prisma.titleRating.create({ data: { userId, kind: "movie", tmdbId: 4, verdict: "up", tags: [], source: "app" } });
    vi.mocked(collectCandidates).mockResolvedValue([{ ...candidate(1), hints: ["aehnlich"] }]);
    vi.mocked(chatJson).mockResolvedValueOnce({
      ok: true,
      json: { rows: { aehnlich: [{ id: "movie-1", reason: "Ähnlich." }] } },
    });
    await runSuggestions(userId);
    expect((await get()).body.rows[0]).toMatchObject({ key: "aehnlich", title: "Weil ihr „Titel 4“ mochtet" });
  });

  it("OpenRouter-Fehler: failed, alte Reihen bleiben, Fehler ohne Key", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1"]));
    await runSuggestions(userId);
    vi.mocked(chatJson).mockResolvedValueOnce({ ok: false, error: "Key ungültig" });
    expect(await runSuggestions(userId)).toBe("failed");

    expect(names((await get()).body)).toEqual([1]);
    const settings = await request(app).get("/ai-settings").set(auth(token));
    expect(settings.body.lastRun).toMatchObject({ status: "failed", error: "Key ungültig" });
    expect(JSON.stringify(settings.body)).not.toContain(KEY);
  });

  it("leeres Parse-Ergebnis: failed, alte Reihen bleiben", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1"]));
    await runSuggestions(userId);
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-999"]));
    expect(await runSuggestions(userId)).toBe("failed");

    expect(names((await get()).body)).toEqual([1]);
    const run = await prisma.suggestionRun.findFirst({ where: { userId, status: "failed" } });
    expect(run?.error).toBe("Die KI hat keine passenden Vorschläge geliefert.");
  });

  it("geworfener Fehler: failed statt running, Sperre frei", async () => {
    vi.mocked(collectCandidates).mockRejectedValueOnce(new Error(`boom ${KEY}`));
    expect(await runSuggestions(userId)).toBe("failed");
    const run = await prisma.suggestionRun.findFirstOrThrow({ where: { userId } });
    expect(run.status).toBe("failed");
    expect(run.error).not.toContain(KEY);
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1"]));
    expect(await runSuggestions(userId)).toBe("done");
  });

  it("fehlgeschlagene Läufe werden ersetzt, gelungene bleiben", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1"]));
    await runSuggestions(userId);
    vi.mocked(chatJson).mockResolvedValue({ ok: false, error: "Key ungültig" });
    await runSuggestions(userId);
    await runSuggestions(userId);
    const statuses = (await prisma.suggestionRun.findMany({ where: { userId } })).map((r) => r.status).sort();
    expect(statuses).toEqual(["done", "failed"]);
  });

  it("behält höchstens 7 Läufe", async () => {
    vi.mocked(chatJson).mockResolvedValue(answer(["movie-1"]));
    for (let i = 0; i < 9; i++) await runSuggestions(userId);
    expect(await prisma.suggestionRun.count({ where: { userId } })).toBe(7);
    expect(await prisma.suggestion.count()).toBe(1);
  });

  it("bewertete und abgelehnte Titel verschwinden sofort", async () => {
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1", "movie-2", "movie-3"]));
    await runSuggestions(userId);
    expect(names((await get()).body)).toEqual([1, 2, 3]);

    await request(app).put("/ratings/movie/1").set(auth(token)).send({ verdict: "up", tags: [] });
    expect((await request(app).post("/suggestions/dismiss").set(auth(token)).send({ kind: "movie", tmdbId: 2 })).status).toBe(204);
    expect(names((await get()).body)).toEqual([3]);
  });

  it("dismiss ist idempotent und prüft die Eingabe", async () => {
    const dismiss = (body: object) => request(app).post("/suggestions/dismiss").set(auth(token)).send(body);
    expect((await dismiss({ kind: "movie", tmdbId: 2 })).status).toBe(204);
    expect((await dismiss({ kind: "movie", tmdbId: 2 })).status).toBe(204);
    expect(await prisma.titleDismissal.count()).toBe(1);
    expect((await dismiss({ kind: "book", tmdbId: 2 })).status).toBe(400);
    expect((await dismiss({ kind: "movie", tmdbId: -1 })).status).toBe(400);
  });

  it("Titel ohne Info fallen weg", async () => {
    vi.mocked(collectCandidates).mockResolvedValue([candidate(1), candidate(5)]);
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1", "movie-5"]));
    await runSuggestions(userId);
    await prisma.titleInfo.deleteMany({ where: { tmdbId: 5 } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      expect(names((await get()).body)).toEqual([1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refresh ohne Key: 400", async () => {
    await request(app).put("/ai-settings").set(auth(token)).send({ model: "m", apiKey: "" });
    const res = await refresh();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Kein Key gespeichert." });
  });

  it("zweimal refresh: 202, dann 409, ein KI-Aufruf", async () => {
    let finish!: (v: ReturnType<typeof answer>) => void;
    vi.mocked(chatJson).mockReturnValueOnce(new Promise((r) => (finish = r)));
    expect((await refresh()).status).toBe(202);
    expect((await refresh()).status).toBe(409);
    expect((await get()).body.running).toBe(true);
    finish(answer(["movie-1"]));
    await vi.waitFor(async () => expect((await get()).body.running).toBe(false));
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it("Lauf vor 5 Minuten: 429", async () => {
    await prisma.suggestionRun.create({
      data: { userId, status: "done", model: "m", startedAt: new Date(Date.now() - 5 * 60_000) },
    });
    const res = await refresh();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Bitte warte noch ein paar Minuten." });
    expect(chatJson).not.toHaveBeenCalled();
  });

  it("hängender Lauf älter als 15 Minuten blockiert nicht", async () => {
    await prisma.suggestionRun.create({
      data: { userId, status: "running", model: "m", startedAt: new Date(Date.now() - 20 * 60_000) },
    });
    vi.mocked(chatJson).mockResolvedValueOnce(answer(["movie-1"]));
    expect((await refresh()).status).toBe(202);
    await vi.waitFor(() => expect(chatJson).toHaveBeenCalledTimes(1));
  });
});
