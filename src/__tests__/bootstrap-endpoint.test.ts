import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import {
  generateServiceToken,
  storeServiceToken,
} from "../lib/service-token.js";

const app = createApp();

// Mock getDownloadVpsConfig and getUploadVpsConfig to return predictable configs
vi.mock("../lib/vps-config.js", () => ({
  getDownloadVpsConfig: vi.fn().mockResolvedValue({
    source: "env",
    apiBaseUrl: "http://localhost:4000",
    apiToken: "test-api-token",
    s3AccessKey: "test-s3-key",
    s3SecretKey: "test-s3-secret",
    s3Endpoint: "https://hel1.s3.example.com",
    s3Bucket: "test-bucket",
    s3Region: "hel1",
    nzbServiceUrl: "http://nzb.example.com",
    dockerImage: "ghcr.io/test/downloader:latest",
    usenetServers: [{ host: "news.example.com", username: "user", password: "pass" }],
  }),
  getUploadVpsConfig: vi.fn().mockResolvedValue({
    source: "env",
    apiBaseUrl: "http://localhost:4000",
    apiToken: "test-api-token",
    s3AccessKey: "test-upload-s3-key",
    s3SecretKey: "test-upload-s3-secret",
    s3Endpoint: "https://hel1.s3.example.com",
    s3Bucket: "test-upload-bucket",
    nzbServiceUrl: "http://nzb.example.com",
    nzbServiceToken: "test-nzb-token",
    usenetProviders: [
      { host: "news1.example.com", port: 563, username: "upuser1", password: "uppass1", ssl: true, connections: 20 },
      { host: "news2.example.com", port: 119, username: "upuser2", password: "uppass2", ssl: false, connections: 10 },
    ],
  }),
}));

describe("Bootstrap endpoint", () => {
  const originalStaticToken = process.env.SERVICE_API_TOKEN;

  afterEach(() => {
    if (originalStaticToken !== undefined) {
      process.env.SERVICE_API_TOKEN = originalStaticToken;
    } else {
      delete process.env.SERVICE_API_TOKEN;
    }
  });

  async function createTestJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Bootstrap Test", titleEn: "Bootstrap Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `bshash-${Date.now()}`, originalFilename: "bootstrap.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });
    return { job, nzbFile, movie };
  }

  it("GET /service/jobs/:id/bootstrap with valid token returns job + config", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job, nzbFile } = await createTestJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.hash).toBe(nzbFile.hash);
    expect(res.body.job.nzbFileId).toBe(nzbFile.id);
    expect(res.body.job.originalFilename).toBe("bootstrap.nzb");
    expect(res.body.job.status).toBeDefined();

    expect(res.body.config).toBeDefined();
    expect(res.body.config.s3AccessKey).toBeDefined();
    expect(res.body.config.usenetServers).toBeDefined();
    expect(res.body.config.nzbServiceUrl).toBeDefined();
  });

  it("GET /service/jobs/:id/bootstrap with token for wrong jobId returns 401", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job: job1 } = await createTestJob();
    const { job: job2 } = await createTestJob();

    // Token scoped to job1
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job1.id, "download");

    // Try to access job2
    const res = await request(app)
      .get(`/service/jobs/${job2.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("not authorized for this job");
  });

  it("GET /service/jobs/:id/bootstrap with invalid token returns 401", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestJob();

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", "Bearer invalid-token-value");

    expect(res.status).toBe(401);
  });

  it("response shape matches what downloader bootstrap expects", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);

    // Job shape expected by 00-fetch-config.sh
    const { job: jobData, config } = res.body;
    expect(jobData).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        hash: expect.any(String),
        nzbFileId: expect.any(String),
        originalFilename: expect.any(String),
        status: expect.any(String),
      }),
    );

    // Config shape expected by 10-generate-config.sh
    expect(config).toEqual(
      expect.objectContaining({
        apiBaseUrl: expect.any(String),
        s3AccessKey: expect.any(String),
        s3SecretKey: expect.any(String),
        s3Endpoint: expect.any(String),
        s3Bucket: expect.any(String),
        nzbServiceUrl: expect.any(String),
        usenetServers: expect.any(Array),
      }),
    );
  });

  it("GET /service/jobs/:id/bootstrap with non-existent job returns 404", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, "nonexistent-job-id", "download");

    const res = await request(app)
      .get("/service/jobs/nonexistent-job-id/bootstrap")
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(404);
  });
});

describe("Upload bootstrap endpoint", () => {
  const originalStaticToken = process.env.SERVICE_API_TOKEN;

  afterEach(() => {
    if (originalStaticToken !== undefined) {
      process.env.SERVICE_API_TOKEN = originalStaticToken;
    } else {
      delete process.env.SERVICE_API_TOKEN;
    }
  });

  async function createTestUploadJob(movieId?: string) {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Upload Test", titleEn: "Upload Test", year: 2025 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash: `uphash-${Date.now()}`,
        originalFilename: "upload.nzb",
        s3Key: `movies/${movie.id}/archive.7z`,
      },
    });
    const job = await prisma.uploadJob.create({
      data: {
        nzbFileId: nzbFile.id,
        movieId: movieId ?? movie.id,
      },
    });
    return { job, nzbFile, movie };
  }

  it("GET /service/jobs/:id/bootstrap with upload job returns upload config", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job, nzbFile, movie } = await createTestUploadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.s3Key).toBe(nzbFile.s3Key);
    expect(res.body.job.movieId).toBe(movie.id);
    expect(res.body.job.status).toBeDefined();

    expect(res.body.config).toBeDefined();
    expect(res.body.config.usenetProviders).toBeDefined();
    expect(res.body.config.nzbServiceUrl).toBeDefined();
    expect(res.body.config.nzbServiceToken).toBeDefined();
  });

  it("GET /service/jobs/:id/bootstrap with token for wrong upload jobId returns 401", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job: job1 } = await createTestUploadJob();
    const { job: job2 } = await createTestUploadJob();

    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job1.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job2.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("not authorized for this job");
  });

  it("upload bootstrap response shape matches what 00-fetch-config.sh expects", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestUploadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);

    const { job: jobData, config } = res.body;
    expect(jobData).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        hash: expect.any(String),
        nzbFileId: expect.any(String),
        s3Key: expect.any(String),
        status: expect.any(String),
      }),
    );

    // Config shape with usenetProviders as array of provider objects
    expect(config).toEqual(
      expect.objectContaining({
        s3AccessKey: expect.any(String),
        s3SecretKey: expect.any(String),
        s3Endpoint: expect.any(String),
        s3Bucket: expect.any(String),
        nzbServiceUrl: expect.any(String),
        nzbServiceToken: expect.any(String),
        usenetProviders: expect.any(Array),
      }),
    );

    // Each provider has the expected structure
    expect(config.usenetProviders.length).toBeGreaterThan(0);
    for (const provider of config.usenetProviders) {
      expect(provider).toEqual(
        expect.objectContaining({
          host: expect.any(String),
          port: expect.any(Number),
          username: expect.any(String),
          password: expect.any(String),
          ssl: expect.any(Boolean),
          connections: expect.any(Number),
        }),
      );
    }
  });

  it("GET /service/jobs/:id/bootstrap with non-existent upload job returns 404", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, "nonexistent-upload-id", "upload");

    const res = await request(app)
      .get("/service/jobs/nonexistent-upload-id/bootstrap")
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(404);
  });

  it("upload job with null movieId still returns valid bootstrap", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "No Movie", titleEn: "No Movie", year: 2025 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash: `uphash-null-${Date.now()}`,
        originalFilename: "upload-null.nzb",
        s3Key: "movies/null-test/archive.7z",
      },
    });
    const job = await prisma.uploadJob.create({
      data: {
        nzbFileId: nzbFile.id,
        movieId: null,
      },
    });

    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.job.movieId).toBeNull();
    expect(res.body.config.usenetProviders).toBeDefined();
  });
});

describe("Cloud-init ENV reduction", () => {
  it("generateCloudInit output contains only JOB_ID, API_BASE_URL, SERVICE_TOKEN in env", async () => {
    const { generateCloudInit } = await import("../lib/hetzner.js");

    const cloudInit = generateCloudInit({
      jobId: "test-job-999",
      apiBaseUrl: "http://api.test.com",
      serviceToken: "abc123def456",
      dockerImage: "ghcr.io/test/downloader:latest",
      serverName: "dl-test",
    });

    // Decode the base64 env content
    const match = cloudInit.match(/content:\s*([A-Za-z0-9+/=]+)/);
    expect(match).not.toBeNull();
    const envContent = Buffer.from(match![1], "base64").toString("utf-8");
    const envLines = envContent.split("\n").filter((l) => l.trim());

    // Exactly 3 env vars
    expect(envLines).toHaveLength(3);
    expect(envContent).toContain("JOB_ID=test-job-999");
    expect(envContent).toContain("API_BASE_URL=http://api.test.com");
    expect(envContent).toContain("SERVICE_TOKEN=abc123def456");

    // Must NOT contain legacy secrets
    expect(envContent).not.toContain("S3_ACCESS_KEY");
    expect(envContent).not.toContain("S3_SECRET_KEY");
    expect(envContent).not.toContain("USENET_");
    expect(envContent).not.toContain("NZB_URL");
    expect(envContent).not.toContain("JOB_HASH");
    expect(envContent).not.toContain("NZB_SERVICE_URL");
  });
});

describe("Upload cloud-init ENV reduction", () => {
  it("generateUploadCloudInit output contains only JOB_ID, API_BASE_URL, SERVICE_TOKEN", async () => {
    const { generateUploadCloudInit } = await import("../lib/hetzner.js");

    const cloudInit = generateUploadCloudInit({
      jobId: "upload-job-123",
      apiBaseUrl: "http://api.upload.test.com",
      serviceToken: "upload-token-xyz",
      dockerImage: "ghcr.io/test/uploader:latest",
      serverName: "ul-test",
    });

    // Decode the base64 env content
    const match = cloudInit.match(/content:\s*([A-Za-z0-9+/=]+)/);
    expect(match).not.toBeNull();
    const envContent = Buffer.from(match![1], "base64").toString("utf-8");
    const envLines = envContent.split("\n").filter((l) => l.trim());

    // Exactly 3 env vars
    expect(envLines).toHaveLength(3);
    expect(envContent).toContain("JOB_ID=upload-job-123");
    expect(envContent).toContain("API_BASE_URL=http://api.upload.test.com");
    expect(envContent).toContain("SERVICE_TOKEN=upload-token-xyz");

    // Must NOT contain any secrets
    expect(envContent).not.toContain("S3_ACCESS_KEY");
    expect(envContent).not.toContain("S3_SECRET_KEY");
    expect(envContent).not.toContain("USENET_");
    expect(envContent).not.toContain("NZB_SERVICE_URL");
    expect(envContent).not.toContain("NZB_SERVICE_TOKEN");
    expect(envContent).not.toContain("DOCKER_IMAGE");
  });
});
