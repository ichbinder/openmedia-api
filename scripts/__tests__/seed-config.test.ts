/**
 * Integration test for seed-config.ts
 *
 * Verifies that after seeding:
 * - All 4 categories exist (usenet_download/usenet_upload removed — providers live in UsenetProvider table)
 * - Both profiles exist
 * - Profile-category mappings are correct
 * - getProfileConfig() returns the expected structure
 * - Seed is idempotent (running twice doesn't duplicate data)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import path from "path";
import { PrismaClient } from "../../generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

/** Project root directory, resolved relative to this test file. */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

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

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function runSeed() {
  execSync("npx tsx scripts/seed-config.ts", {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL },
    stdio: "pipe",
  });
}

beforeAll(async () => {
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

  // Run seed
  runSeed();
});

afterAll(async () => {
  await prisma.$disconnect();
  // Restore original DATABASE_URL to avoid leaking into other suites
  if (ORIGINAL_DATABASE_URL !== undefined) {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
});

describe("seed-config integration", () => {
  it("creates all 5 categories", async () => {
    const categories = await prisma.configCategory.findMany({
      orderBy: { name: "asc" },
    });
    const names = categories.map((c) => c.name);
    expect(names).toEqual([
      "docker_images",
      "nzb_service",
      "runtime",
      "s3",
      "vpn",
    ]);
  });

  it("creates both profiles", async () => {
    const profiles = await prisma.configProfile.findMany({
      orderBy: { name: "asc" },
    });
    const names = profiles.map((p) => p.name);
    expect(names).toEqual(["download_vps", "upload_vps"]);
  });

  it("download_vps has 4 category mappings", async () => {
    const profile = await prisma.configProfile.findUnique({
      where: { name: "download_vps" },
    });
    expect(profile).not.toBeNull();

    const mappings = await prisma.configProfileCategory.findMany({
      where: { profileId: profile!.id },
      include: { category: { select: { name: true } } },
    });
    const catNames = mappings.map((m) => m.category.name).sort();
    expect(catNames).toEqual([
      "docker_images",
      "nzb_service",
      "runtime",
      "s3",
    ]);
  });

  it("upload_vps has 4 category mappings", async () => {
    const profile = await prisma.configProfile.findUnique({
      where: { name: "upload_vps" },
    });
    expect(profile).not.toBeNull();

    const mappings = await prisma.configProfileCategory.findMany({
      where: { profileId: profile!.id },
      include: { category: { select: { name: true } } },
    });
    const catNames = mappings.map((m) => m.category.name).sort();
    expect(catNames).toEqual([
      "docker_images",
      "nzb_service",
      "runtime",
      "s3",
    ]);
  });

  it("getProfileConfig download_vps returns expected structure", async () => {
    // Import dynamically so DATABASE_URL is set
    const { getProfileConfig } = await import(
      "../../src/lib/config-service.js"
    );
    const config = await getProfileConfig("download_vps");
    expect(config).not.toBeNull();

    // s3 keys
    expect(config!.s3).toBeDefined();
    expect(config!.s3).toHaveProperty("access_key");
    expect(config!.s3).toHaveProperty("secret_key");
    expect(config!.s3).toHaveProperty("endpoint");
    expect(config!.s3).toHaveProperty("bucket");
    expect(config!.s3).toHaveProperty("region");

    // usenet_download no longer in config — providers live in UsenetProvider table

    // nzb_service keys
    expect(config!.nzb_service).toBeDefined();
    expect(config!.nzb_service).toHaveProperty("url");

    // docker_images keys
    expect(config!.docker_images).toBeDefined();
    expect(config!.docker_images).toHaveProperty("downloader");

    // runtime keys
    expect(config!.runtime).toBeDefined();
    expect(config!.runtime).toHaveProperty("api_base_url");
    // service_api_token removed — dynamic per-job tokens (M029)
  });

  it("getProfileConfig upload_vps returns expected structure", async () => {
    const { getProfileConfig } = await import(
      "../../src/lib/config-service.js"
    );
    const config = await getProfileConfig("upload_vps");
    expect(config).not.toBeNull();

    // s3 keys
    expect(config!.s3).toBeDefined();
    expect(config!.s3).toHaveProperty("access_key");
    expect(config!.s3).toHaveProperty("secret_key");
    expect(config!.s3).toHaveProperty("endpoint");
    expect(config!.s3).toHaveProperty("bucket");

    // usenet_upload no longer in config — providers live in UsenetProvider table

    // nzb_service keys
    expect(config!.nzb_service).toBeDefined();
    expect(config!.nzb_service).toHaveProperty("url");
    expect(config!.nzb_service).toHaveProperty("token");

    // docker_images keys
    expect(config!.docker_images).toBeDefined();
    expect(config!.docker_images).toHaveProperty("uploader");

    // runtime keys
    expect(config!.runtime).toBeDefined();
    expect(config!.runtime).toHaveProperty("api_base_url");
    // service_api_token removed — dynamic per-job tokens (M029)
  });

  it("seed is idempotent — second run preserves counts and values", async () => {
    const countsBefore = {
      categories: await prisma.configCategory.count(),
      profiles: await prisma.configProfile.count(),
      mappings: await prisma.configProfileCategory.count(),
      entries: await prisma.configEntry.count(),
    };

    // Snapshot a representative entry value
    const s3Category = await prisma.configCategory.findUnique({
      where: { name: "s3" },
    });
    const s3BucketBefore = await prisma.configEntry.findUnique({
      where: { categoryId_key: { categoryId: s3Category!.id, key: "bucket" } },
    });

    // Run seed again
    runSeed();

    const countsAfter = {
      categories: await prisma.configCategory.count(),
      profiles: await prisma.configProfile.count(),
      mappings: await prisma.configProfileCategory.count(),
      entries: await prisma.configEntry.count(),
    };

    expect(countsAfter).toEqual(countsBefore);

    // Verify values are preserved (upsert with empty update doesn't overwrite)
    const s3BucketAfter = await prisma.configEntry.findUnique({
      where: { categoryId_key: { categoryId: s3Category!.id, key: "bucket" } },
    });
    expect(s3BucketAfter!.value).toBe(s3BucketBefore!.value);
  });
});
