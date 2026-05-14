import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import { _resetJellyfinSetupRateLimit } from "../routes/jellyfin.js";

const app = createApp();

async function createUser(emailSeed?: string) {
  const seed = emailSeed || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await prisma.user.create({
    data: {
      email: `jfsetup-${seed}@test.de`,
      password: "$2b$10$hash",
      name: "Jellyfin Setup Test",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

beforeEach(() => {
  _resetJellyfinSetupRateLimit();
});

describe("POST /jellyfin/plugin/setup", () => {
  it("erzeugt einen om_-Token mit purpose='jellyfin-plugin' und liefert manifestUrl", async () => {
    const { user, token } = await createUser();

    const res = await request(app)
      .post("/jellyfin/plugin/setup")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body.tokenId).toBeDefined();
    expect(res.body.name).toMatch(/^Jellyfin Plugin \(\d{2}\.\d{2}\.\d{4}\)$/);
    expect(res.body.prefix).toMatch(/^om_/);
    expect(res.body.manifestUrl).toContain("/jellyfin/repo/manifest.json?t=om_");
    expect(res.body.expiresAt).toBeDefined();

    // Token sitzt mit purpose='jellyfin-plugin' in der DB.
    const dbToken = await prisma.apiToken.findUnique({ where: { id: res.body.tokenId } });
    expect(dbToken).not.toBeNull();
    expect(dbToken!.userId).toBe(user.id);
    expect(dbToken!.purpose).toBe("jellyfin-plugin");
    expect(dbToken!.revokedAt).toBeNull();
  });

  it("lehnt unauthenticated Requests mit 401 ab", async () => {
    const res = await request(app).post("/jellyfin/plugin/setup");
    expect(res.status).toBe(401);
  });

  it("greift Rate-Limit (1/min) — 2. Setup direkt nach 1. liefert 429", async () => {
    const { token } = await createUser();

    const first = await request(app)
      .post("/jellyfin/plugin/setup")
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/jellyfin/plugin/setup")
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("Rate-Limit ist pro User — ein anderer User wird nicht geblockt", async () => {
    const a = await createUser("alpha");
    const b = await createUser("bravo");

    const ra = await request(app)
      .post("/jellyfin/plugin/setup")
      .set("Authorization", `Bearer ${a.token}`);
    expect(ra.status).toBe(201);

    const rb = await request(app)
      .post("/jellyfin/plugin/setup")
      .set("Authorization", `Bearer ${b.token}`);
    expect(rb.status).toBe(201);
  });
});
