import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { getTmdbSeasonById } from "../lib/tmdb.js";

vi.mock("../lib/tmdb.js", async (importActual) => ({
  ...(await importActual<typeof import("../lib/tmdb.js")>()),
  getTmdbSeasonById: vi.fn(),
}));

const mockedSeason = vi.mocked(getTmdbSeasonById);
const app = createApp();

const PAST = "2020-01-01";

function season(count: number, airDate: string | null = PAST) {
  return {
    status: "found" as const,
    show: {} as never,
    episodes: Array.from({ length: count }, (_, i) => ({
      episode: i + 1,
      titleDe: `Folge ${i + 1}`,
      airDate,
      runtime: 45,
    })),
  };
}

async function getAuthToken(email = "progress@test.de") {
  const res = await request(app).post("/auth/register").send({ email, password: "test123", name: "Progress User" });
  return res.body.token as string;
}

async function movieFile(hash: string, movieId?: string) {
  const id = movieId ?? (await prisma.nzbMovie.create({ data: { titleDe: "Film", titleEn: "Film" } })).id;
  return prisma.nzbFile.create({ data: { hash, originalFilename: `${hash}.mkv`, movieId: id } });
}

describe("Progress Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  function put(body: unknown, t: string | null = token) {
    const req = request(app).put("/progress");
    return (t ? req.set("Authorization", `Bearer ${t}`) : req).send(body as object);
  }

  it("legt einen Eintrag an und aktualisiert denselben beim zweiten Melden", async () => {
    const file = await movieFile("a");
    const first = await put({ nzbFileId: file.id, positionSec: 100, durationSec: 6000 });
    expect(first.status).toBe(200);
    expect(first.body.progress).toEqual({ positionSec: 100, durationSec: 6000, finished: false });

    await put({ nzbFileId: file.id, positionSec: 200, durationSec: 6000 });
    const rows = await prisma.watchProgress.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].positionSec).toBe(200);
  });

  it("hält pro Film eine Zeile und merkt sich die zuletzt gemeldete Datei", async () => {
    const a = await movieFile("a");
    const b = await movieFile("b", a.movieId!);
    await put({ nzbFileId: a.id, positionSec: 100, durationSec: 6000 });
    await put({ nzbFileId: b.id, positionSec: 150, durationSec: 6000 });

    const rows = await prisma.watchProgress.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].nzbFileId).toBe(b.id);
  });

  it("speichert Folgen über die Episode", async () => {
    const show = await prisma.nzbShow.create({ data: { tmdbId: 1, titleDe: "S", titleEn: "S" } });
    const episode = await prisma.nzbEpisode.create({ data: { showId: show.id, season: 1, episode: 1 } });
    const file = await prisma.nzbFile.create({ data: { hash: "e", originalFilename: "e.mkv", episodeId: episode.id } });
    await put({ nzbFileId: file.id, positionSec: 100.4, durationSec: 2000 });

    const row = await prisma.watchProgress.findFirstOrThrow();
    expect(row.episodeId).toBe(episode.id);
    expect(row.movieId).toBeNull();
    expect(row.positionSec).toBe(100);
  });

  it("POST wirkt wie PUT", async () => {
    const file = await movieFile("a");
    const res = await request(app)
      .post("/progress")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ nzbFileId: file.id, positionSec: 100, durationSec: 6000 }));
    expect(res.status).toBe(200);
    expect(await prisma.watchProgress.count()).toBe(1);
  });

  it("markiert ab 90 % als fertig und behält das beim Neustart", async () => {
    const file = await movieFile("a");
    const done = await put({ nzbFileId: file.id, positionSec: 5400, durationSec: 6000 });
    expect(done.body.progress.finished).toBe(true);

    const again = await put({ nzbFileId: file.id, positionSec: 30, durationSec: 6000 });
    expect(again.body.progress.finished).toBe(true);
    expect((await prisma.watchProgress.findFirstOrThrow()).finishedAt).not.toBeNull();
  });

  it("ändert finishedAt bei späteren Meldungen ab 90 % nicht mehr", async () => {
    const file = await movieFile("a");
    await put({ nzbFileId: file.id, positionSec: 5400, durationSec: 6000 });
    const first = (await prisma.watchProgress.findFirstOrThrow()).finishedAt;
    await put({ nzbFileId: file.id, positionSec: 5700, durationSec: 6000 });
    expect((await prisma.watchProgress.findFirstOrThrow()).finishedAt).toEqual(first);
  });

  it("blendet den Eintrag wieder ein, wenn weitergeschaut wird", async () => {
    const file = await movieFile("a");
    await put({ nzbFileId: file.id, positionSec: 100, durationSec: 6000 });
    await prisma.watchProgress.updateMany({ data: { hiddenAt: new Date() } });
    await put({ nzbFileId: file.id, positionSec: 200, durationSec: 6000 });
    expect((await prisma.watchProgress.findFirstOrThrow()).hiddenAt).toBeNull();
  });

  it.each([
    { positionSec: 10, durationSec: 0 },
    { positionSec: -1, durationSec: 6000 },
    { positionSec: "abc", durationSec: 6000 },
    { positionSec: 10, durationSec: null },
    { positionSec: 7000, durationSec: 6000 },
    { positionSec: 10, durationSec: 1e12 },
    { positionSec: 1e12, durationSec: 1e12 },
    { positionSec: 0, durationSec: 0.4 },
  ])("lehnt %j mit 400 ab", async (body) => {
    const file = await movieFile("a");
    const res = await put({ nzbFileId: file.id, ...body });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual(expect.any(String));
    expect(await prisma.watchProgress.count()).toBe(0);
  });

  it("antwortet 404 bei unbekannter Datei und bei Datei ohne Titel", async () => {
    expect((await put({ nzbFileId: "gibt-es-nicht", positionSec: 10, durationSec: 100 })).status).toBe(404);
    const orphan = await prisma.nzbFile.create({ data: { hash: "o", originalFilename: "o.mkv" } });
    expect((await put({ nzbFileId: orphan.id, positionSec: 10, durationSec: 100 })).status).toBe(404);
  });

  it("antwortet 401 ohne Token", async () => {
    const res = await put({ nzbFileId: "x", positionSec: 10, durationSec: 100 }, null);
    expect(res.status).toBe(401);
  });
});

describe("Weiterschauen", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    token = await getAuthToken("continue@test.de");
    userId = (await prisma.user.findFirstOrThrow({ where: { email: "continue@test.de" } })).id;
    mockedSeason.mockReset();
    mockedSeason.mockImplementation(async (_id, s) => (s === 1 ? season(8) : { status: "not_found" }));
  });

  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const put = (nzbFileId: string, positionSec: number, durationSec: number) =>
    auth(request(app).put("/progress")).send({ nzbFileId, positionSec, durationSec });
  const items = async () => {
    const res = await auth(request(app).get("/progress/continue"));
    expect(res.status).toBe(200);
    return res.body.items as any[];
  };

  async function showFile(tmdbId: number, seasonNo: number, episodeNo: number) {
    const show = await prisma.nzbShow.upsert({
      where: { tmdbId },
      update: {},
      create: { tmdbId, titleDe: "Serie", titleEn: "Show", posterPath: "/p.jpg" },
    });
    const episode = await prisma.nzbEpisode.create({
      data: { showId: show.id, season: seasonNo, episode: episodeNo },
    });
    const file = await prisma.nzbFile.create({
      data: {
        hash: `s${tmdbId}-${seasonNo}-${episodeNo}`,
        originalFilename: "e.mkv",
        episodeId: episode.id,
        s3StreamKey: "k",
      },
    });
    return { show, episode, file };
  }

  async function movie(tmdbId: number, positionSec = 900, durationSec = 6000) {
    const m = await prisma.nzbMovie.create({ data: { tmdbId, titleDe: `Film ${tmdbId}`, titleEn: "M" } });
    const file = await prisma.nzbFile.create({
      data: { hash: `m${tmdbId}`, originalFilename: "m.mkv", movieId: m.id, s3StreamKey: "k" },
    });
    await put(file.id, positionSec, durationSec);
    return { movie: m, file };
  }

  it("zeigt nach fertiger S1E3 die Folge S1E4 ohne Datei", async () => {
    const { file } = await showFile(10, 1, 3);
    await put(file.id, 2700, 3000);
    const [item] = await items();
    expect(item).toMatchObject({
      kind: "episode", tmdbId: 10, season: 1, episode: 4, episodeTitle: "Folge 4",
      positionSec: 0, durationSec: 0, nzbFileId: null, request: null,
    });
  });

  it("S1E3 fertig, danach S1E4 bei 20 s → Eintrag S1E4", async () => {
    const e3 = await showFile(10, 1, 3);
    const e4 = await showFile(10, 1, 4);
    await put(e3.file.id, 2700, 3000);
    await put(e4.file.id, 20, 3000);
    expect(await items()).toMatchObject([{ season: 1, episode: 4, positionSec: 0, nzbFileId: e4.file.id }]);
  });

  it("springt bei TMDB-Fehler in der aktuellen Staffel nicht in die nächste", async () => {
    const { file } = await showFile(10, 1, 3);
    await put(file.id, 2700, 3000);
    mockedSeason.mockImplementation(async (_id, s) => (s === 1 ? { status: "error", reason: "down" } : season(8)));
    expect(await items()).toEqual([]);
    const res = await auth(request(app).get(`/progress/next/${file.id}`));
    expect(res.body).toEqual({ next: null });
  });

  it("springt nach der letzten Folge in die nächste Staffel, aber nur wenn ausgestrahlt", async () => {
    const { file } = await showFile(10, 1, 8);
    await put(file.id, 2700, 3000);
    mockedSeason.mockImplementation(async (_id, s) => (s === 1 ? season(8) : season(3)));
    expect(await items()).toMatchObject([{ season: 2, episode: 1 }]);

    mockedSeason.mockImplementation(async (_id, s) => {
      if (s === 1) return season(8);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      return season(3, tomorrow);
    });
    expect(await items()).toEqual([]);
  });

  it("zeigt eine angefangene Folge mit ihrer Stelle", async () => {
    const { file } = await showFile(10, 1, 3);
    await put(file.id, 900, 3000);
    expect(await items()).toMatchObject([{ season: 1, episode: 3, positionSec: 900, durationSec: 3000, nzbFileId: file.id }]);
  });

  it("zeigt bei Wiederholung einer früheren Folge diese Folge", async () => {
    const e5 = await showFile(10, 1, 5);
    const e2 = await showFile(10, 1, 2);
    await put(e5.file.id, 2700, 3000);
    await put(e2.file.id, 120, 3000);
    expect(await items()).toMatchObject([{ season: 1, episode: 2, positionSec: 120 }]);
  });

  it("meldet Datei und offene Anfrage der nächsten Folge", async () => {
    const e3 = await showFile(10, 1, 3);
    const e4 = await showFile(10, 1, 4);
    await prisma.episodeRequest.create({ data: { userId, episodeId: e4.episode.id, status: "searching" } });
    await put(e3.file.id, 2700, 3000);
    expect(await items()).toMatchObject([{ episode: 4, nzbFileId: e4.file.id, request: { status: "searching", waitReason: null } }]);
  });

  it("lässt die Serie weg, wenn TMDB fehlt, behält Filme und antwortet 200", async () => {
    const e3 = await showFile(10, 1, 3);
    await put(e3.file.id, 2700, 3000);
    await movie(20);
    mockedSeason.mockResolvedValue({ status: "error", reason: "down" });
    expect(await items()).toMatchObject([{ kind: "movie", tmdbId: 20 }]);
  });

  it("lässt nur die Serie weg, wenn TMDB wirft", async () => {
    const e3 = await showFile(10, 1, 3);
    await put(e3.file.id, 2700, 3000);
    await movie(20);
    mockedSeason.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await items()).toMatchObject([{ kind: "movie", tmdbId: 20 }]);
  });

  it("nimmt bei einer Lücke in den Folgennummern die nächste vorhandene Folge", async () => {
    const e2 = await showFile(10, 1, 2);
    await put(e2.file.id, 2700, 3000);
    const gap = season(4);
    gap.episodes = gap.episodes.filter((e) => e.episode !== 3);
    mockedSeason.mockResolvedValue(gap);
    expect(await items()).toMatchObject([{ season: 1, episode: 4 }]);
  });

  it("verwendet für einen leeren TMDB-Titel null wie bei begonnenen Folgen", async () => {
    const e3 = await showFile(10, 1, 3);
    await put(e3.file.id, 2700, 3000);
    const empty = season(8);
    empty.episodes[3].titleDe = "";
    mockedSeason.mockResolvedValue(empty);
    expect(await items()).toMatchObject([{ episode: 4, episodeTitle: null }]);
  });

  it("behält einen Film, dessen Datei gelöscht wurde", async () => {
    const { file } = await movie(20);
    await prisma.nzbFile.delete({ where: { id: file.id } });
    expect(await items()).toMatchObject([{ kind: "movie", nzbFileId: null, positionSec: 900 }]);
  });

  it("zeigt den Status der Film-Anfrage", async () => {
    await movie(20);
    await prisma.movieRequest.create({
      data: { userId, tmdbId: 20, status: "failed", allowedGroup: "german", failReason: "no_candidate" },
    });
    expect(await items()).toMatchObject([{ request: { status: "failed", waitReason: "no_candidate" } }]);
  });

  it("zeigt fertige Filme nicht und begrenzt auf 20, neueste zuerst", async () => {
    await movie(1, 5700, 6000);
    for (let i = 100; i < 121; i++) await movie(i);
    const list = await items();
    expect(list).toHaveLength(20);
    expect(list[0].tmdbId).toBe(120);
    expect(list.map((i) => i.tmdbId)).not.toContain(1);
  });

  it("entfernt eine Serie per DELETE und blendet sie bei neuem Fortschritt wieder ein", async () => {
    const { file } = await showFile(10, 1, 3);
    await put(file.id, 900, 3000);
    const del = await auth(request(app).delete("/progress/show/10"));
    expect(del.body).toEqual({ hidden: 1 });
    expect(await items()).toEqual([]);
    await put(file.id, 1000, 3000);
    expect(await items()).toHaveLength(1);
  });

  it("entfernt einen Film per DELETE und lehnt unbekannte Arten mit 400 ab", async () => {
    await movie(20);
    expect((await auth(request(app).delete("/progress/movie/20"))).body).toEqual({ hidden: 1 });
    expect(await items()).toEqual([]);
    expect((await auth(request(app).delete("/progress/foo/1"))).status).toBe(400);
  });

  it("liefert die nächste Folge zu einer Datei, null für Filme und 404 für Unbekanntes", async () => {
    const e3 = await showFile(10, 1, 3);
    const res = await auth(request(app).get(`/progress/next/${e3.file.id}`));
    expect(res.body.next).toMatchObject({ showTmdbId: 10, season: 1, episode: 4 });

    const m = await movie(20);
    expect((await auth(request(app).get(`/progress/next/${m.file.id}`))).body).toEqual({ next: null });
    expect((await auth(request(app).get("/progress/next/gibt-es-nicht"))).status).toBe(404);
  });

  it("liefert myProgress auf den Detailseiten", async () => {
    const e3 = await showFile(10, 1, 3);
    await put(e3.file.id, 900, 3000);
    const showRes = await auth(request(app).get("/nzb/shows/by-tmdb/10"));
    expect(showRes.body.myProgress).toEqual([{ season: 1, episode: 3, positionSec: 900, durationSec: 3000, state: "started" }]);

    await movie(20);
    const movieRes = await auth(request(app).get("/nzb/movies/by-tmdb/20"));
    expect(movieRes.body.myProgress).toEqual({ positionSec: 900, durationSec: 6000, state: "started" });
  });
});
