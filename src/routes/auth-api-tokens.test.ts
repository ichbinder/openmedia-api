import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { hashToken, TOKEN_PREFIX } from "../lib/api-token.js";

// Mock TMDB so the /downloads/request integration test below doesn't hit
// the real client (which returns "disabled" without a TMDB_API_KEY).
vi.mock("../lib/tmdb.js", () => ({
  searchTmdbMovie: vi.fn().mockResolvedValue({
    status: "found",
    movie: {
      tmdbId: 999_002,
      imdbId: "tt9990002",
      titleDe: "Token Auth Movie",
      titleEn: "Token Auth Movie",
      description: "Mock for API token auth tests.",
      year: 2024,
      posterPath: "/mock-poster.jpg",
    },
  }),
}));

const app = createApp();

// Minimal valid NZB XML for downloads/request test
const VALID_NZB = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test@test.com" date="1234567890" subject="Token.Test.2024.1080p [1/1] &quot;test.rar&quot; yEnc (1/10)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100000" number="1">tokentest@test.com</segment></segments>
  </file>
</nzb>`;

let emailCounter = 0;

/** Register a user and return { token (JWT), userId }. */
async function registerUser() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `apitoken-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "Token User" });
  return { jwt: res.body.token as string, userId: res.body.user.id as string };
}

/** Create an API token for a user and return { plaintext, id, prefix }. */
async function createApiToken(jwt: string, name = "Test Token", expiresInDays = 30) {
  const res = await request(app)
    .post("/auth/api-tokens")
    .set("Authorization", `Bearer ${jwt}`)
    .send({ name, expiresInDays });
  return { plaintext: res.body.token as string, id: res.body.id as string, prefix: res.body.prefix as string };
}

describe("API Token Management", () => {
  let jwt: string;
  let userId: string;

  beforeEach(async () => {
    const user = await registerUser();
    jwt = user.jwt;
    userId = user.userId;
  });

  // --- CRUD ---

  it("erstellt einen API-Token mit om_ Prefix", async () => {
    const res = await request(app)
      .post("/auth/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "Meine Extension", expiresInDays: 30 });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^om_/);
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.name).toBe("Meine Extension");
    expect(res.body.prefix).toMatch(/^om_/);
    expect(res.body.prefix.length).toBe(11);
    expect(res.body.expiresAt).toBeDefined();
  });

  it("lehnt fehlenden Name ab", async () => {
    const res = await request(app)
      .post("/auth/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ expiresInDays: 30 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Name");
  });

  it("lehnt ungültige expiresInDays ab", async () => {
    const res = await request(app)
      .post("/auth/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "Test", expiresInDays: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("30");
  });

  it("listet Tokens ohne Hash/Klartext", async () => {
    await createApiToken(jwt, "Token A");
    await createApiToken(jwt, "Token B");

    const res = await request(app)
      .get("/auth/api-tokens")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(2);

    const t = res.body.tokens[0];
    expect(t.tokenPrefix).toMatch(/^om_/);
    expect(t.name).toBeDefined();
    expect(t.expiresAt).toBeDefined();
    // Must NOT contain hash or plaintext
    expect(t.tokenHash).toBeUndefined();
    expect(t.token).toBeUndefined();
  });

  it("widerruft einen Token", async () => {
    const { id } = await createApiToken(jwt);

    const res = await request(app)
      .delete(`/auth/api-tokens/${id}`)
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify in DB
    const dbToken = await prisma.apiToken.findUnique({ where: { id } });
    expect(dbToken?.revokedAt).not.toBeNull();
  });

  it("kann fremde Tokens nicht widerrufen", async () => {
    const { id } = await createApiToken(jwt);

    // Register second user
    const other = await registerUser();

    const res = await request(app)
      .delete(`/auth/api-tokens/${id}`)
      .set("Authorization", `Bearer ${other.jwt}`);

    expect(res.status).toBe(404);
  });

  // --- Auth Middleware ---

  it("authentifiziert mit gültigem om_-Token", async () => {
    const { plaintext } = await createApiToken(jwt);

    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
  });

  it("lehnt abgelaufenen Token ab", async () => {
    const { plaintext } = await createApiToken(jwt);

    // Manually expire the token in DB
    const tokenHash = hashToken(plaintext);
    await prisma.apiToken.update({
      where: { tokenHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("abgelaufen");
  });

  it("lehnt widerrufenen Token ab", async () => {
    const { plaintext, id } = await createApiToken(jwt);

    // Revoke
    await request(app)
      .delete(`/auth/api-tokens/${id}`)
      .set("Authorization", `Bearer ${jwt}`);

    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("widerrufen");
  });

  it("lehnt ungültigen om_-Token ab", async () => {
    const res = await request(app)
      .get("/auth/me")
      .set("Authorization", "Bearer om_dieserTokenExistiertNichtUndIstTotalFalsch");

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Ungültiger");
  });

  it("aktualisiert lastUsedAt bei API-Token-Auth", async () => {
    const { plaintext } = await createApiToken(jwt);

    // First request
    await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${plaintext}`);

    // Poll for fire-and-forget update with timeout
    const tokenHash = hashToken(plaintext);
    let dbToken;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      dbToken = await prisma.apiToken.findUnique({ where: { tokenHash } });
      if (dbToken?.lastUsedAt) break;
    }
    expect(dbToken?.lastUsedAt).not.toBeNull();
  });

  // --- Integration: downloads/request with API token ---

  it("POST /downloads/request mit om_-Token setzt korrekte userId", async () => {
    const { plaintext } = await createApiToken(jwt);

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ nzbContent: VALID_NZB, title: "Token Auth Movie" });

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();

    // Verify job has the correct userId
    const job = await prisma.downloadJob.findUnique({ where: { id: res.body.job.id } });
    expect(job?.userId).toBe(userId);
  });
});
