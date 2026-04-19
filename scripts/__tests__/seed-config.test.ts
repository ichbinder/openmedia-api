/**
 * Integration test for seed-config.ts
 *
 * Verifies that after seeding:
 * - All 6 categories exist
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

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test";

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
});

describe("seed-config integration", () => {
  it("creates all 6 categories", async () => {
    const categories = await prisma.configCategory.findMany({
      orderBy: { name: "asc" },
    });
    const names = categories.map((c) => c.name);
    expect(names).toEqual([
      "docker_images",
      "nzb_service",
      "runtime",
      "s3",
      "usenet_download",
      "usenet_upload",
    ]);
  });

  it("creates both profiles", async () => {
    const profiles = await prisma.configProfile.findMany({
      orderBy: { name: "asc" },
    });
    const names = profiles.map((p) => p.name);
    expect(names).toEqual(["download_vps", "upload_vps"]);
  });

  it("download_vps has 5 category mappings", async () => {
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
      "usenet_download",
    ]);
  });

  it("upload_vps has 5 category mappings", async () => {
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
      "usenet_upload",
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

    // usenet_download keys
    expect(config!.usenet_download).toBeDefined();
    expect(config!.usenet_download).toHaveProperty("servers");

    // nzb_service keys
    expect(config!.nzb_service).toBeDefined();
    expect(config!.nzb_service).toHaveProperty("url");

    // docker_images keys
    expect(config!.docker_images).toBeDefined();
    expect(config!.docker_images).toHaveProperty("downloader");

    // runtime keys
    expect(config!.runtime).toBeDefined();
    expect(config!.runtime).toHaveProperty("api_base_url");
    expect(config!.runtime).toHaveProperty("service_api_token");
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

    // usenet_upload keys
    expect(config!.usenet_upload).toBeDefined();
    expect(config!.usenet_upload).toHaveProperty("provider_1_host");
    expect(config!.usenet_upload).toHaveProperty("provider_1_port");
    expect(config!.usenet_upload).toHaveProperty("provider_1_user");
    expect(config!.usenet_upload).toHaveProperty("provider_1_pass");
    expect(config!.usenet_upload).toHaveProperty("provider_1_conns");
    expect(config!.usenet_upload).toHaveProperty("provider_1_ssl");

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
    expect(config!.runtime).toHaveProperty("service_api_token");
  });

  it("seed is idempotent — second run does not change counts", async () => {
    const countsBefore = {
      categories: await prisma.configCategory.count(),
      profiles: await prisma.configProfile.count(),
      mappings: await prisma.configProfileCategory.count(),
      entries: await prisma.configEntry.count(),
    };

    // Run seed again
    runSeed();

    const countsAfter = {
      categories: await prisma.configCategory.count(),
      profiles: await prisma.configProfile.count(),
      mappings: await prisma.configProfileCategory.count(),
      entries: await prisma.configEntry.count(),
    };

    expect(countsAfter).toEqual(countsBefore);
  });
});
