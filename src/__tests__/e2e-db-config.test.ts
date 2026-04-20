/**
 * E2E integration test for vps-config.ts config readers.
 *
 * Verifies that getDownloadVpsConfig() and getUploadVpsConfig() return
 * non-null results when realistic values are seeded into the DB —
 * WITHOUT mocking vps-config.js.
 *
 * Usenet servers come from the UsenetProvider table (not legacy config entries).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execSync } from "child_process";
import path from "path";
import { PrismaClient } from "../../generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomBytes } from "node:crypto";
import request from "supertest";

/** Project root directory, resolved relative to this test file. */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// Mock ONLY Hetzner — vps-config.js must NOT be mocked (that's the point of this test)
vi.mock("../lib/hetzner.js", () => ({
  isHetznerConfigured: vi.fn().mockReturnValue(true),
  createServer: vi.fn().mockResolvedValue({ id: 1, name: "mock-server", status: "running", ip: "1.2.3.4" }),
  deleteServer: vi.fn().mockResolvedValue(true),
  getServer: vi.fn().mockResolvedValue(null),
  listServers: vi.fn().mockResolvedValue([]),
  findZombieServers: vi.fn().mockResolvedValue([]),
  cleanupZombieServers: vi.fn().mockResolvedValue({ deleted: 0, failed: 0 }),
  generateCloudInit: vi.fn().mockReturnValue("#!/bin/bash\necho mock"),
  generateUploadCloudInit: vi.fn().mockReturnValue("#!/bin/bash\necho mock"),
  provisionUploadVps: vi.fn().mockResolvedValue({
    server: { id: 1, name: "mock-upload-vps", publicIpv4: "1.2.3.4" },
  }),
}));

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test";

/**
 * Safety check: only allow force-reset against known test databases.
 * Prevents accidental destruction of dev/prod DBs.
 */
function assertTestDatabase(url: string): void {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  const isLocalhost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  const isTestPort = parsed.port === "5433";
  const isAllowedDbName =
    dbName === "cinescope_test" || dbName.endsWith("_test");

  if (!(isLocalhost && isTestPort && isAllowedDbName)) {
    throw new Error(
      `Refusing to run destructive tests against "${url}". ` +
        "Set TEST_DATABASE_URL to the dedicated local test database (localhost:5433 with DB name ending in '_test')."
    );
  }
}

assertTestDatabase(DATABASE_URL);

// Set for subprocess and shared prisma module
process.env.DATABASE_URL = DATABASE_URL;

const TEST_MASTER_KEY = randomBytes(32).toString("hex");
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_MASTER_KEY;

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ─── Realistic test values to override CHANGE_ME / empty defaults ────

const REALISTIC_OVERRIDES: Record<string, Record<string, string>> = {
  s3: {
    access_key: "AKIAIOSFODNN7EXAMPLE",
    secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    endpoint: "https://s3.hel1.your-objectstorage.com",
    bucket: "cinescope-test-bucket",
  },
  nzb_service: {
    url: "https://nzb.test.com/api",
    token: "nzb-test-token-abc123",
  },
  runtime: {
    api_base_url: "https://api.test.cinescope.dev",
  },
};

beforeAll(async () => {
  // Set encryption key for UsenetProvider password encryption
  process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;

  // Push schema to test DB
  execSync("npx prisma db push --force-reset --accept-data-loss", {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  // Run seed to create categories, profiles, mappings, and default entries
  execSync("npx tsx scripts/seed-config.ts", {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });

  // Override CHANGE_ME / empty values with realistic test data
  for (const [categoryName, entries] of Object.entries(REALISTIC_OVERRIDES)) {
    const category = await prisma.configCategory.findUnique({
      where: { name: categoryName },
    });
    if (!category) throw new Error(`Category '${categoryName}' not found after seed`);

    for (const [key, value] of Object.entries(entries)) {
      await prisma.configEntry.upsert({
        where: { categoryId_key: { categoryId: category.id, key } },
        update: { value },
        create: {
          categoryId: category.id,
          key,
          value,
          encrypted: false,
          displayName: key,
        },
      });
    }
  }

  // Seed UsenetProvider entries for download and upload
  const { createProvider } = await import("../lib/usenet-provider-service.js");
  await createProvider({
    name: "E2E Download Provider",
    host: "news.test.com",
    port: 563,
    ssl: true,
    username: "testuser",
    password: "testpass",
    connections: 20,
    isDownload: true,
    isUpload: false,
  });
  await createProvider({
    name: "E2E Upload Provider",
    host: "news-upload.test.com",
    postHost: "news-upload.test.com",
    port: 563,
    ssl: true,
    username: "uploaduser",
    password: "uploadpass",
    connections: 20,
    isDownload: false,
    isUpload: true,
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  // Restore original env vars to avoid leaking into other suites
  if (ORIGINAL_DATABASE_URL !== undefined) {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
  if (ORIGINAL_ENCRYPTION_KEY !== undefined) {
    process.env.ENCRYPTION_MASTER_KEY = ORIGINAL_ENCRYPTION_KEY;
  } else {
    delete process.env.ENCRYPTION_MASTER_KEY;
  }
});

describe("e2e-db-config: config readers without mock", () => {
  it("getDownloadVpsConfig() returns non-null with correct structure", async () => {
    const { getDownloadVpsConfig } = await import("../../src/lib/vps-config.js");
    const config = await getDownloadVpsConfig();

    expect(config).not.toBeNull();
    expect(config!.apiBaseUrl).toBe("https://api.test.cinescope.dev");
    expect(config!.s3AccessKey).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config!.s3SecretKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(config!.s3Endpoint).toBe("https://s3.hel1.your-objectstorage.com");
    expect(config!.s3Bucket).toBe("cinescope-test-bucket");
    expect(config!.s3Region).toBe("hel1");
    expect(config!.nzbServiceUrl).toBe("https://nzb.test.com/api");
    expect(config!.dockerImage).toBe("ghcr.io/ichbinder/openmedia-downloader:latest");
    expect(config!.usenetServers).toHaveLength(1);
    expect(config!.usenetServers[0].host).toBe("news.test.com");
    expect(config!.usenetServers[0].username).toBe("testuser");
    expect(config!.usenetServers[0].password).toBe("testpass");
  });

  it("getUploadVpsConfig() returns non-null with correct structure", async () => {
    const { getUploadVpsConfig } = await import("../../src/lib/vps-config.js");
    const config = await getUploadVpsConfig();

    expect(config).not.toBeNull();
    expect(config!.apiBaseUrl).toBe("https://api.test.cinescope.dev");
    expect(config!.s3AccessKey).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config!.s3SecretKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(config!.s3Endpoint).toBe("https://s3.hel1.your-objectstorage.com");
    expect(config!.s3Bucket).toBe("cinescope-test-bucket");
    expect(config!.nzbServiceUrl).toBe("https://nzb.test.com/api");
    expect(config!.nzbServiceToken).toBe("nzb-test-token-abc123");
    expect(config!.dockerImage).toBe("ghcr.io/ichbinder/openmedia-uploader:latest");
    expect(config!.usenetProviders).toHaveLength(1);
    expect(config!.usenetProviders[0].host).toBe("news-upload.test.com");
    expect(config!.usenetProviders[0].username).toBe("uploaduser");
    expect(config!.usenetProviders[0].password).toBe("uploadpass");
    expect(config!.usenetProviders[0].ssl).toBe(true);
    expect(config!.usenetProviders[0].connections).toBe(20);
  });
});

// ─── Negative test: missing config returns null ────

describe("e2e-db-config: config readers return null when DB config is missing", () => {
  it("getDownloadVpsConfig() returns null with empty config tables", async () => {
    // Wipe config entries and providers to simulate missing config
    await prisma.configEntry.deleteMany();
    await prisma.usenetProvider.deleteMany();

    // Dynamic import to get a fresh module evaluation
    const { getDownloadVpsConfig } = await import("../../src/lib/vps-config.js");
    const config = await getDownloadVpsConfig();
    expect(config).toBeNull();
  });

  it("getUploadVpsConfig() returns null with empty config tables", async () => {
    // Ensure tables are empty independent of test order
    await prisma.configEntry.deleteMany();
    await prisma.usenetProvider.deleteMany();

    const { getUploadVpsConfig } = await import("../../src/lib/vps-config.js");
    const config = await getUploadVpsConfig();
    expect(config).toBeNull();
  });

  afterAll(async () => {
    // Re-seed for subsequent test suites
    execSync("npx tsx scripts/seed-config.ts", {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL },
      stdio: "pipe",
    });

    // Re-apply realistic config overrides
    for (const [categoryName, entries] of Object.entries(REALISTIC_OVERRIDES)) {
      const category = await prisma.configCategory.findUnique({
        where: { name: categoryName },
      });
      if (!category) continue;
      for (const [key, value] of Object.entries(entries)) {
        await prisma.configEntry.upsert({
          where: { categoryId_key: { categoryId: category.id, key } },
          update: { value },
          create: { categoryId: category.id, key, value, encrypted: false, displayName: key },
        });
      }
    }

    // Re-seed UsenetProvider entries
    const { createProvider } = await import("../lib/usenet-provider-service.js");
    await createProvider({
      name: "E2E Download Provider",
      host: "news.test.com",
      port: 563,
      ssl: true,
      username: "testuser",
      password: "testpass",
      connections: 20,
      isDownload: true,
      isUpload: false,
    });
    await createProvider({
      name: "E2E Upload Provider",
      host: "news-upload.test.com",
      postHost: "news-upload.test.com",
      port: 563,
      ssl: true,
      username: "uploaduser",
      password: "uploadpass",
      connections: 20,
      isDownload: false,
      isUpload: true,
    });
  });
});

// ─── Bootstrap endpoint tests with real DB config (no vps-config mock) ────

describe("e2e-db-config: Bootstrap endpoint with real DB config", () => {
  const originalStaticToken = process.env.SERVICE_API_TOKEN;

  beforeEach(async () => {
    // Ensure per-job token path is used (not static ENV token)
    delete process.env.SERVICE_API_TOKEN;

    // Clean up job-related tables for isolation
    await prisma.$executeRawUnsafe("DELETE FROM service_tokens");
    await prisma.$executeRawUnsafe("DELETE FROM download_jobs");
    await prisma.$executeRawUnsafe("DELETE FROM upload_jobs");
    await prisma.$executeRawUnsafe("DELETE FROM nzb_files");
    await prisma.$executeRawUnsafe("DELETE FROM nzb_movies");
  });

  afterAll(() => {
    if (originalStaticToken !== undefined) {
      process.env.SERVICE_API_TOKEN = originalStaticToken;
    }
  });

  async function createTestDownloadJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "E2E Bootstrap DL", titleEn: "E2E Bootstrap DL", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `e2e-dlhash-${Date.now()}`, originalFilename: "e2e-dl.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });
    return { job, nzbFile, movie };
  }

  async function createTestUploadJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "E2E Bootstrap UL", titleEn: "E2E Bootstrap UL", year: 2025 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash: `e2e-ulhash-${Date.now()}`,
        originalFilename: "e2e-ul.nzb",
        s3Key: `movies/${movie.id}/archive.7z`,
      },
    });
    const job = await prisma.uploadJob.create({
      data: { nzbFileId: nzbFile.id, movieId: movie.id },
    });
    return { job, nzbFile, movie };
  }

  it("Download bootstrap returns 200 with real DB config payload", async () => {
    const { createApp } = await import("../app.js");
    const { generateServiceToken, storeServiceToken } = await import("../lib/service-token.js");

    const app = createApp();
    const { job, nzbFile } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);

    // Job payload
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.hash).toBe(nzbFile.hash);
    expect(res.body.job.nzbFileId).toBe(nzbFile.id);
    expect(res.body.job.originalFilename).toBe("e2e-dl.nzb");

    // Config payload — values from real DB, not mocked
    expect(res.body.config.s3AccessKey).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(res.body.config.s3SecretKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.body.config.s3Endpoint).toBe("https://s3.hel1.your-objectstorage.com");
    expect(res.body.config.s3Bucket).toBe("cinescope-test-bucket");
    expect(res.body.config.s3Region).toBe("hel1");
    expect(res.body.config.nzbServiceUrl).toBe("https://nzb.test.com/api");
    expect(res.body.config.usenetServers).toHaveLength(1);
    expect(res.body.config.usenetServers[0].host).toBe("news.test.com");
    expect(res.body.config.usenetServers[0].username).toBe("testuser");
  });

  it("Upload bootstrap returns 200 with real DB config payload", async () => {
    const { createApp } = await import("../app.js");
    const { generateServiceToken, storeServiceToken } = await import("../lib/service-token.js");

    const app = createApp();
    const { job, nzbFile, movie } = await createTestUploadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);

    // Job payload
    expect(res.body.job.id).toBe(job.id);
    expect(res.body.job.hash).toBe(nzbFile.hash);
    expect(res.body.job.s3Key).toBe(nzbFile.s3Key);
    expect(res.body.job.movieId).toBe(movie.id);

    // Config payload — values from real DB, not mocked
    expect(res.body.config.s3AccessKey).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(res.body.config.s3SecretKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.body.config.s3Endpoint).toBe("https://s3.hel1.your-objectstorage.com");
    expect(res.body.config.s3Bucket).toBe("cinescope-test-bucket");
    expect(res.body.config.nzbServiceUrl).toBe("https://nzb.test.com/api");
    expect(res.body.config.nzbServiceToken).toBe("nzb-test-token-abc123");
    expect(res.body.config.usenetProviders).toHaveLength(1);
    expect(res.body.config.usenetProviders[0].host).toBe("news-upload.test.com");
    expect(res.body.config.usenetProviders[0].username).toBe("uploaduser");
    expect(res.body.config.usenetProviders[0].password).toBe("uploadpass");
  });
});
