import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import prisma from "../lib/prisma.js";

const app = createApp();

const register = async (email: string) => {
  const res = await request(app).post("/auth/register").send({ email, password: "test123", name: "Test" });
  return { token: res.body.token as string, userId: res.body.user.id as string };
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const put = (token: string, path: string, body: unknown) =>
  request(app).put(`/ratings${path}`).set(auth(token)).send(body as object);

describe("/ratings", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    ({ token, userId } = await register("ratings@test.de"));
  });

  it("ohne Token: 401", async () => {
    expect((await request(app).get("/ratings")).status).toBe(401);
  });

  it("speichert, liest und listet eine Bewertung", async () => {
    const res = await put(token, "/movie/550", { verdict: "up", tags: ["spannend"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: "movie",
      tmdbId: 550,
      verdict: "up",
      tags: ["spannend"],
      forWhom: null,
      source: "app",
    });
    expect(new Date(res.body.ratedAt).toISOString()).toBe(res.body.ratedAt);

    const one = await request(app).get("/ratings/movie/550").set(auth(token));
    expect(one.status).toBe(200);
    expect(one.body.verdict).toBe("up");

    const list = await request(app).get("/ratings").set(auth(token));
    expect(list.body.items).toHaveLength(1);
  });

  it("zweites PUT überschreibt (letzter gewinnt)", async () => {
    await put(token, "/movie/550", { verdict: "up", tags: [] });
    const res = await put(token, "/movie/550", { verdict: "down", tags: [], source: "quiz" });
    expect(res.body).toMatchObject({ verdict: "down", source: "quiz" });
    expect(await prisma.titleRating.count()).toBe(1);
  });

  it("überschreibt eine Trakt-Bewertung mit source app", async () => {
    await prisma.titleRating.create({
      data: { userId, kind: "movie", tmdbId: 7, verdict: "meh", tags: [], source: "trakt" },
    });
    const res = await put(token, "/movie/7", { verdict: "up", tags: [] });
    expect(res.body.source).toBe("app");
  });

  it("forWhom einer Person aus dem Profil ist erlaubt", async () => {
    await prisma.tasteProfile.create({ data: { userId, persons: [{ id: "p1", name: "A" }] } });
    const res = await put(token, "/movie/5", { verdict: "up", tags: [], forWhom: "p1" });
    expect(res.status).toBe(200);
    expect(res.body.forWhom).toBe("p1");
  });

  it("ungültige Eingaben: 400", async () => {
    expect((await put(token, "/movie/550", { verdict: "up", tags: [], forWhom: "erfunden" })).status).toBe(400);
    expect((await put(token, "/film/550", { verdict: "up", tags: [] })).status).toBe(400);
    expect((await put(token, "/movie/0", { verdict: "up", tags: [] })).status).toBe(400);
    expect((await put(token, "/movie/abc", { verdict: "up", tags: [] })).status).toBe(400);
    expect((await request(app).get("/ratings/film/1").set(auth(token))).status).toBe(400);
  });

  it("DELETE: 204, danach 404; zweites DELETE 404", async () => {
    await put(token, "/show/1399", { verdict: "meh", tags: [] });
    expect((await request(app).delete("/ratings/show/1399").set(auth(token))).status).toBe(204);
    expect((await request(app).get("/ratings/show/1399").set(auth(token))).status).toBe(404);
    expect((await request(app).delete("/ratings/show/1399").set(auth(token))).status).toBe(404);
  });

  it("zweites Konto sieht fremde Bewertungen nicht", async () => {
    await put(token, "/movie/550", { verdict: "up", tags: [] });
    const other = await register("other@test.de");
    expect((await request(app).get("/ratings/movie/550").set(auth(other.token))).status).toBe(404);
    expect((await request(app).get("/ratings").set(auth(other.token))).body.items).toEqual([]);
  });
});
