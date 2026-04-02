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
      nzbUrl: "http://api.example.com/nzb/files/xyz/raw",
      apiBaseUrl: "http://api.example.com",
      apiToken: "test-token",
      s3AccessKey: "s3-key",
      s3SecretKey: "s3-secret",
      s3Endpoint: "https://hel1.your-objectstorage.com",
      s3Bucket: "openmedia-files",
      s3Region: "hel1",
      usenetHost: "news.example.com",
      usenetPort: 563,
      usenetUser: "user",
      usenetPassword: "pass",
      usenetSsl: true,
      usenetConnections: 10,
      dockerImage: "ghcr.io/ichbinder/openmedia-downloader:latest",
      hetznerToken: "test-token-123",
    };

    it("generates valid cloud-init YAML with docker run", () => {
      const cloudInit = generateCloudInit(defaultParams);

      expect(cloudInit).toContain("#cloud-config");
      expect(cloudInit).toContain("write_files:");
      expect(cloudInit).toContain("docker pull");
      expect(cloudInit).toContain("docker run");
      expect(cloudInit).toContain("openmedia-downloader");
      expect(cloudInit).toContain("fail_job");
      expect(cloudInit).toContain("--env-file");

      // Env vars are base64-encoded in write_files
      const b64Match = cloudInit.match(/content: (\S+)/);
      expect(b64Match).toBeTruthy();
      const envContent = Buffer.from(b64Match![1], "base64").toString();
      expect(envContent).toContain("test-job-123");
      expect(envContent).toContain("api.example.com");
      expect(envContent).toContain("openmedia-files");
    });

    it("passes hash and NZB URL as env vars", () => {
      const cloudInit = generateCloudInit(defaultParams);

      const b64Match = cloudInit.match(/content: (\S+)/);
      const envContent = Buffer.from(b64Match![1], "base64").toString();
      expect(envContent).toContain("JOB_HASH=");
      expect(envContent).toContain("abc123hash");
      expect(envContent).toContain("NZB_URL=");
    });

    it("includes S3 and Usenet credentials", () => {
      const cloudInit = generateCloudInit({
        ...defaultParams,
        s3Bucket: "my-bucket",
      });

      const b64Match = cloudInit.match(/content: (\S+)/);
      const envContent = Buffer.from(b64Match![1], "base64").toString();
      expect(envContent).toContain("S3_ACCESS_KEY=");
      expect(envContent).toContain("S3_SECRET_KEY=");
      expect(envContent).toContain("USENET_HOST=");
      expect(envContent).toContain("my-bucket");
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
    const origS3Key = process.env.S3_ACCESS_KEY;
    const origS3Secret = process.env.S3_SECRET_KEY;
    const origS3Endpoint = process.env.S3_ENDPOINT;
    const origS3Bucket = process.env.S3_BUCKET;
    const origUsenetHost = process.env.USENET_HOST;
    const origUsenetUser = process.env.USENET_USER;
    const origUsenetPass = process.env.USENET_PASSWORD;
    const origNzbService = process.env.NZB_SERVICE_URL;

    process.env.HETZNER_API_TOKEN = "fake-token-for-test";
    process.env.API_BASE_URL = "http://localhost:4000";
    process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "test-key";
    process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || "test-secret";
    process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "https://hel1.test.com";
    process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
    process.env.USENET_HOST = process.env.USENET_HOST || "news.test.com";
    process.env.USENET_USER = process.env.USENET_USER || "user";
    process.env.USENET_PASSWORD = process.env.USENET_PASSWORD || "pass";
    process.env.NZB_SERVICE_URL = process.env.NZB_SERVICE_URL || "http://localhost:3001";

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/provision`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("queued");
    } finally {
      // Restore all env vars
      const restore = (key: string, orig: string | undefined) => {
        if (orig !== undefined) process.env[key] = orig;
        else delete process.env[key];
      };
      restore("HETZNER_API_TOKEN", origToken);
      restore("API_BASE_URL", origApiBase);
      restore("S3_ACCESS_KEY", origS3Key);
      restore("S3_SECRET_KEY", origS3Secret);
      restore("S3_ENDPOINT", origS3Endpoint);
      restore("S3_BUCKET", origS3Bucket);
      restore("USENET_HOST", origUsenetHost);
      restore("USENET_USER", origUsenetUser);
      restore("USENET_PASSWORD", origUsenetPass);
      restore("NZB_SERVICE_URL", origNzbService);
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
