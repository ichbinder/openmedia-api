import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import prisma from "../lib/prisma.js";

process.env.ENCRYPTION_MASTER_KEY ||= "a".repeat(64);

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("/ai-settings", () => {
  let token: string;
  let userId: string;

  const get = () => request(app).get("/ai-settings").set(auth(token));
  const put = (body: object) => request(app).put("/ai-settings").set(auth(token)).send(body);

  beforeEach(async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "ai@test.de", password: "test123", name: "Test" });
    token = res.body.token;
    userId = res.body.user.id;
  });

  afterEach(() => vi.unstubAllGlobals());

  it("ohne Token: 401", async () => {
    expect((await request(app).get("/ai-settings")).status).toBe(401);
  });

  it("GET ohne Zeile", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ model: "", hasKey: false, lastRun: null });
  });

  it("speichert Key, meldet hasKey und verrät den Key nie", async () => {
    const saved = await put({ model: "x", apiKey: "sk-1" });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("sk-1");
    const res = await get();
    expect(res.body).toMatchObject({ model: "x", hasKey: true });
    expect(JSON.stringify(res.body)).not.toContain("sk-1");
    const row = await prisma.aiSettings.findUnique({ where: { userId } });
    expect(row?.keyCipher).not.toContain("sk-1");
  });

  it("PUT ohne apiKey behält den Key", async () => {
    await put({ model: "x", apiKey: "sk-1" });
    await put({ model: "y" });
    expect((await get()).body).toMatchObject({ model: "y", hasKey: true });
  });

  it("PUT mit leerem apiKey löscht ihn", async () => {
    await put({ model: "x", apiKey: "sk-1" });
    await put({ model: "y", apiKey: "" });
    expect((await get()).body).toMatchObject({ model: "y", hasKey: false });
  });

  it("PUT mit leerem Modell: 400", async () => {
    expect((await put({ model: "" })).status).toBe(400);
    expect((await put({ model: "m".repeat(101) })).status).toBe(400);
  });

  it("GET liefert den neuesten Lauf als lastRun", async () => {
    await prisma.suggestionRun.create({
      data: { userId, status: "ok", model: "x", startedAt: new Date("2026-01-01") },
    });
    await prisma.suggestionRun.create({
      data: { userId, status: "failed", error: "Key ungültig", model: "x", startedAt: new Date("2026-02-01") },
    });
    const res = await get();
    expect(res.body.lastRun).toMatchObject({ status: "failed", error: "Key ungültig", finishedAt: null });
  });

  it("test ohne Key", async () => {
    const res = await request(app).post("/ai-settings/test").set(auth(token));
    expect(res.body).toEqual({ ok: false, error: "Kein Key gespeichert." });
  });

  it("test mit gemocktem OpenRouter", async () => {
    await put({ model: "x", apiKey: "sk-1" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post("/ai-settings/test").set(auth(token));
    expect(res.body).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-1");
  });

  it("test gibt OpenRouter-Fehler gekürzt weiter", async () => {
    await put({ model: "x", apiKey: "sk-1" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("sk-1", { status: 401 })));
    const res = await request(app).post("/ai-settings/test").set(auth(token));
    expect(res.body).toEqual({ ok: false, error: "Key ungültig" });
  });
});
