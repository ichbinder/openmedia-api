import { describe, it, expect, afterEach } from "vitest";
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
    const defaultParams = {
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
    };

    it("generates valid cloud-init YAML", () => {
      const cloudInit = generateCloudInit(defaultParams);

      expect(cloudInit).toContain("#cloud-config");
      expect(cloudInit).toContain("test-job-123");
      expect(cloudInit).toContain("api.example.com");
      expect(cloudInit).toContain("openmedia-files");
      expect(cloudInit).toContain("sha256sum");
      expect(cloudInit).toContain("aws s3 cp");
      expect(cloudInit).toContain("post-process.sh");
    });

    it("uses correct host paths (not container paths)", () => {
      const cloudInit = generateCloudInit(defaultParams);

      expect(cloudInit).toContain("/opt/downloads/complete");
      expect(cloudInit).toContain("/opt/downloads/config:/config");
    });

    it("includes S3 upload configuration", () => {
      const cloudInit = generateCloudInit({
        ...defaultParams,
        s3Bucket: "my-bucket",
      });

      expect(cloudInit).toContain("AWS_ACCESS_KEY_ID");
      expect(cloudInit).toContain("AWS_SECRET_ACCESS_KEY");
      expect(cloudInit).toContain("my-bucket");
    });
  });
});

// Route tests — mocked Hetzner API to avoid real server creation
describe("Download VPS Routes", () => {
  it("provision endpoint requires Hetzner config", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });

    const origToken = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/provision`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("nicht konfiguriert");
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
    }
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

    const origToken = process.env.HETZNER_API_TOKEN;
    const origApiBase = process.env.API_BASE_URL;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";
    process.env.API_BASE_URL = "http://localhost:4000";

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/provision`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("queued");
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
      else delete process.env.HETZNER_API_TOKEN;
      if (origApiBase) process.env.API_BASE_URL = origApiBase;
      else delete process.env.API_BASE_URL;
    }
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

    try {
      const res = await request(app)
        .post("/downloads/jobs/nonexistent-id/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
      else delete process.env.HETZNER_API_TOKEN;
    }
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

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/cleanup`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("keinen zugeordneten Server");
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
      else delete process.env.HETZNER_API_TOKEN;
    }
  });
});
