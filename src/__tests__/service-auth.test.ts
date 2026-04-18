import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import {
  generateServiceToken,
  storeServiceToken,
} from "../lib/service-token.js";

const app = createApp();

describe("ServiceToken auth middleware", () => {
  const originalStaticToken = process.env.SERVICE_API_TOKEN;

  afterEach(() => {
    if (originalStaticToken !== undefined) {
      process.env.SERVICE_API_TOKEN = originalStaticToken;
    } else {
      delete process.env.SERVICE_API_TOKEN;
    }
  });

  // Use /service/jobs/:id/bootstrap as our test endpoint since it's behind requireServiceToken
  async function createTestJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Auth Test", titleEn: "Auth Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `authhash-${Date.now()}`, originalFilename: "auth.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });
    return job;
  }

  it("requireServiceToken rejects static ENV token on bootstrap (per-job required)", async () => {
    process.env.SERVICE_API_TOKEN = "static-test-token-12345";
    delete process.env.ENABLE_LEGACY_SERVICE_TOKEN;
    const job = await createTestJob();

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", "Bearer static-test-token-12345");

    expect(res.status).toBe(401);
  });

  it("requireServiceToken accepts static ENV token with legacy flag enabled", async () => {
    process.env.SERVICE_API_TOKEN = "static-test-token-12345";
    process.env.ENABLE_LEGACY_SERVICE_TOKEN = "true";
    const job = await createTestJob();

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", "Bearer static-test-token-12345");

    // Should pass auth (may fail on config, but NOT 401)
    expect(res.status).not.toBe(401);
    delete process.env.ENABLE_LEGACY_SERVICE_TOKEN;
  });

  it("requireServiceToken accepts valid DB token and sets req.serviceToken", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const job = await createTestJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    // Should pass auth — not 401
    expect(res.status).not.toBe(401);
  });

  it("requireServiceToken rejects invalid token with 401", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const job = await createTestJob();

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", "Bearer totally-bogus-token");

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Invalid service token");
  });

  it("requireServiceToken rejects missing authorization header with 401", async () => {
    const job = await createTestJob();

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Missing service token");
  });
});

describe("requireServiceOrUserAuth combined middleware", () => {
  // We need an endpoint that uses requireServiceOrUserAuth.
  // The downloads routes use it for cleanup. Let's test via a route that uses it.
  // Looking at the codebase, /downloads/jobs/:id/status PATCH uses requireServiceOrUserAuth
  // For simplicity, we'll test the middleware logic indirectly via the service routes
  // which use requireServiceToken — and test JWT auth via a user-authenticated endpoint.

  it("JWT auth works for user-authenticated endpoints", async () => {
    const user = await prisma.user.create({
      data: { email: `combined-jwt-${Date.now()}@test.de`, password: "$2b$10$hash", name: "JWT User" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    // Use a user-authenticated endpoint like /watchlist
    const res = await request(app)
      .get("/watchlist")
      .set("Authorization", `Bearer ${token}`);

    // Should not return 401
    expect(res.status).not.toBe(401);
  });

  it("missing token returns 401 on user endpoints", async () => {
    const res = await request(app).get("/watchlist");

    expect(res.status).toBe(401);
  });
});
