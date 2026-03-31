import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isHetznerConfigured,
  generateCloudInit,
} from "../lib/hetzner.js";

describe("Hetzner Service", () => {
  describe("isHetznerConfigured", () => {
    const originalToken = process.env.HETZNER_API_TOKEN;

    afterEach(() => {
      if (originalToken) {
        process.env.HETZNER_API_TOKEN = originalToken;
      } else {
        delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("returns true when token is set", () => {
      process.env.HETZNER_API_TOKEN = "test-token";
      expect(isHetznerConfigured()).toBe(true);
    });

    it("returns false when token is missing", () => {
      delete process.env.HETZNER_API_TOKEN;
      expect(isHetznerConfigured()).toBe(false);
    });

    it("returns false when token is empty", () => {
      process.env.HETZNER_API_TOKEN = "";
      expect(isHetznerConfigured()).toBe(false);
    });
  });

  describe("generateCloudInit", () => {
    it("generates valid cloud-init YAML", () => {
      const cloudInit = generateCloudInit({
        jobId: "test-job-123",
        nzbHash: "abc123hash",
        apiBaseUrl: "http://api.example.com",
        apiToken: "test-token",
        s3AccessKey: "s3-key",
        s3SecretKey: "s3-secret",
        s3Endpoint: "https://hel1.your-objectstorage.com",
        s3Bucket: "openmedia-files",
        usenetHost: "news.example.com",
        usenetPort: 563,
        usenetUser: "user",
        usenetPassword: "pass",
        usenetSsl: true,
      });

      expect(cloudInit).toContain("#cloud-config");
      expect(cloudInit).toContain("test-job-123");
      expect(cloudInit).toContain("abc123hash");
      expect(cloudInit).toContain("api.example.com");
      expect(cloudInit).toContain("openmedia-files");
      expect(cloudInit).toContain("sha256sum");
      expect(cloudInit).toContain("aws s3 cp");
      expect(cloudInit).toContain("post-process.sh");
    });

    it("includes S3 upload configuration", () => {
      const cloudInit = generateCloudInit({
        jobId: "j1",
        nzbHash: "h1",
        apiBaseUrl: "http://localhost",
        apiToken: "t1",
        s3AccessKey: "ak",
        s3SecretKey: "sk",
        s3Endpoint: "https://hel1.your-objectstorage.com",
        s3Bucket: "my-bucket",
        usenetHost: "news.example.com",
        usenetPort: 563,
        usenetUser: "u",
        usenetPassword: "p",
        usenetSsl: true,
      });

      expect(cloudInit).toContain("AWS_ACCESS_KEY_ID");
      expect(cloudInit).toContain("AWS_SECRET_ACCESS_KEY");
      expect(cloudInit).toContain("my-bucket");
    });
  });
});

// Route tests use mocked Hetzner API to avoid real server creation
describe("Download VPS Routes", () => {
  // These tests verify the route logic without hitting the real Hetzner API
  // The actual Hetzner API integration is tested separately

  it("provision endpoint requires Hetzner config", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    // Create test user
    const user = await prisma.user.create({
      data: { email: `vps-test-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    // Create test movie + nzb file + job
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });

    // Remove Hetzner token temporarily
    const origToken = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;

    const res = await request(app)
      .post(`/downloads/jobs/${job.id}/provision`)
      .set("Authorization", `Bearer ${token}`);

    // Restore token
    if (origToken) process.env.HETZNER_API_TOKEN = origToken;

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("nicht konfiguriert");
  });

  it("provision endpoint rejects non-queued jobs", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test2-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash2-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id, status: "downloading" },
    });

    // Set a fake token so the config check passes
    const origToken = process.env.HETZNER_API_TOKEN;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";

    const res = await request(app)
      .post(`/downloads/jobs/${job.id}/provision`)
      .set("Authorization", `Bearer ${token}`);

    if (origToken) process.env.HETZNER_API_TOKEN = origToken;
    else delete process.env.HETZNER_API_TOKEN;

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("queued");
  });

  it("cleanup endpoint returns 404 for unknown job", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test3-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const origToken = process.env.HETZNER_API_TOKEN;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";

    const res = await request(app)
      .post("/downloads/jobs/nonexistent-id/cleanup")
      .set("Authorization", `Bearer ${token}`);

    if (origToken) process.env.HETZNER_API_TOKEN = origToken;
    else delete process.env.HETZNER_API_TOKEN;

    expect(res.status).toBe(404);
  });

  it("cleanup endpoint rejects jobs without server", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test4-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash4-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id, status: "completed" },
    });

    const origToken = process.env.HETZNER_API_TOKEN;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";

    const res = await request(app)
      .post(`/downloads/jobs/${job.id}/cleanup`)
      .set("Authorization", `Bearer ${token}`);

    if (origToken) process.env.HETZNER_API_TOKEN = origToken;
    else delete process.env.HETZNER_API_TOKEN;

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("keinen zugeordneten Server");
  });
});
