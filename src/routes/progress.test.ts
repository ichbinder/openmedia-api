import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

const app = createApp();

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
