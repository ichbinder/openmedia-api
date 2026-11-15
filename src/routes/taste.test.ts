import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import prisma from "../lib/prisma.js";
import { recordTraktImport } from "../lib/taste-service.js";

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const person = (name: string, over: object = {}) => ({ name, limits: [], limitsText: "", ...over });

describe("/taste", () => {
  let token: string;
  let userId: string;

  const putTaste = (body: unknown) => request(app).put("/taste").set(auth(token)).send(body as object);
  const getRatingFor = async (tmdbId: number) =>
    (await request(app).get(`/ratings/movie/${tmdbId}`).set(auth(token))).body;

  beforeEach(async () => {
    const res = await request(app).post("/auth/register").send({ email: "taste@test.de", password: "test123", name: "Test" });
    token = res.body.token;
    userId = res.body.user.id;
  });

  it("ohne Token: 401", async () => {
    expect((await request(app).get("/taste")).status).toBe(401);
  });

  it("GET ohne Profil: exists false, legt nichts an", async () => {
    const res = await request(app).get("/taste").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: false,
      persons: [],
      genres: [],
      likesText: "",
      traktImportedAt: null,
      traktImportCounts: null,
    });
    expect(await prisma.tasteProfile.count()).toBe(0);
  });

  it("PUT vergibt IDs und speichert", async () => {
    const res = await putTaste({ persons: [person("A"), person("B")], genres: ["drama"], likesText: "gut" });
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    const ids = res.body.persons.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(res.body).toMatchObject({ genres: ["drama"], likesText: "gut" });
    expect((await request(app).get("/taste").set(auth(token))).body.persons).toEqual(res.body.persons);
  });

  it("PUT mit erfundener id: 400", async () => {
    expect((await putTaste({ persons: [person("A", { id: "fremd" })] })).status).toBe(400);
  });

  it("PUT mit unbekanntem Genre: 400", async () => {
    expect((await putTaste({ persons: [person("A")], genres: ["western"] })).status).toBe(400);
  });

  it("entfernte Person setzt forWhom ihrer Bewertungen auf null", async () => {
    const saved = await putTaste({ persons: [person("A"), person("B")] });
    const [a, b] = saved.body.persons as { id: string }[];
    await request(app).put("/ratings/movie/1").set(auth(token)).send({ verdict: "up", forWhom: b.id });
    await request(app).put("/ratings/movie/2").set(auth(token)).send({ verdict: "up", forWhom: a.id });

    const res = await putTaste({ persons: [person("A", { id: a.id })] });
    expect(res.body.persons.map((p: { id: string }) => p.id)).toEqual([a.id]);
    expect((await getRatingFor(1)).forWhom).toBeNull();
    expect((await getRatingFor(2)).forWhom).toBe(a.id);

    const again = await request(app).put("/ratings/movie/3").set(auth(token)).send({ verdict: "up", forWhom: a.id });
    expect(again.status).toBe(200);
  });

  it("recordTraktImport legt Profil an und behält es beim Speichern", async () => {
    await recordTraktImport(userId, { rated: 3, seen: 2, skipped: 1 });
    await putTaste({ persons: [person("A")] });
    const body = (await request(app).get("/taste").set(auth(token))).body;
    expect(body.traktImportCounts).toEqual({ rated: 3, seen: 2, skipped: 1 });
    expect(new Date(body.traktImportedAt).toISOString()).toBe(body.traktImportedAt);
  });
});
