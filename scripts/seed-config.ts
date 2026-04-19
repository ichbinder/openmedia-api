/**
 * Idempotent Config Seed Script
 *
 * Seeds the config store with categories, profiles, profile-category mappings,
 * and config entries required by getProfileConfig('download_vps') and
 * getProfileConfig('upload_vps').
 *
 * Safe to run multiple times — uses upsert with empty update for entries
 * so existing values are never overwritten.
 *
 * Usage: npx tsx scripts/seed-config.ts
 */

import { PrismaClient } from "../generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://cinescope:cinescope_dev@localhost:5432/cinescope";

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

// ─── Data Definitions ────────────────────────────────────────────────

const CATEGORIES = [
  { name: "s3", displayName: "S3-Speicher" },
  { name: "nzb_service", displayName: "NZB-Service" },
  { name: "docker_images", displayName: "Docker Images" },
  { name: "runtime", displayName: "Runtime" },
] as const;

const PROFILES = [
  { name: "download_vps", displayName: "Download VPS" },
  { name: "upload_vps", displayName: "Upload VPS" },
] as const;

const PROFILE_CATEGORIES: Record<string, string[]> = {
  download_vps: ["s3", "nzb_service", "docker_images", "runtime"],
  upload_vps: ["s3", "nzb_service", "docker_images", "runtime"],
};

interface EntryDef {
  key: string;
  displayName: string;
  defaultValue: string;
  sensitive: boolean;
}

const ENTRIES_BY_CATEGORY: Record<string, EntryDef[]> = {
  s3: [
    { key: "access_key", displayName: "Access Key", defaultValue: "CHANGE_ME", sensitive: true },
    { key: "secret_key", displayName: "Secret Key", defaultValue: "CHANGE_ME", sensitive: true },
    { key: "endpoint", displayName: "Endpoint", defaultValue: "", sensitive: false },
    { key: "bucket", displayName: "Bucket", defaultValue: "", sensitive: false },
    { key: "region", displayName: "Region", defaultValue: "hel1", sensitive: false },
  ],
  nzb_service: [
    { key: "url", displayName: "NZB Service URL", defaultValue: "", sensitive: false },
    { key: "token", displayName: "NZB Service Token", defaultValue: "CHANGE_ME", sensitive: true },
  ],
  docker_images: [
    { key: "downloader", displayName: "Downloader Image", defaultValue: "ghcr.io/ichbinder/openmedia-downloader:latest", sensitive: false },
    { key: "uploader", displayName: "Uploader Image", defaultValue: "ghcr.io/ichbinder/openmedia-uploader:latest", sensitive: false },
  ],
  runtime: [
    { key: "api_base_url", displayName: "API Base URL", defaultValue: "", sensitive: false },
    { key: "service_api_token", displayName: "Service API Token", defaultValue: "CHANGE_ME", sensitive: true },
  ],
};

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("[seed-config] Starting idempotent config seed...");

  // 1. Upsert categories
  const categoryIds: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    const row = await prisma.configCategory.upsert({
      where: { name: cat.name },
      create: { name: cat.name, displayName: cat.displayName },
      update: { displayName: cat.displayName },
    });
    categoryIds[cat.name] = row.id;
    console.log(`  Category: ${cat.name} (${row.id})`);
  }

  // 2. Upsert profiles
  const profileIds: Record<string, string> = {};
  for (const prof of PROFILES) {
    const row = await prisma.configProfile.upsert({
      where: { name: prof.name },
      create: { name: prof.name, displayName: prof.displayName },
      update: { displayName: prof.displayName },
    });
    profileIds[prof.name] = row.id;
    console.log(`  Profile: ${prof.name} (${row.id})`);
  }

  // 3. Upsert profile-category mappings
  for (const [profileName, catNames] of Object.entries(PROFILE_CATEGORIES)) {
    const profileId = profileIds[profileName];
    for (const catName of catNames) {
      const categoryId = categoryIds[catName];
      await prisma.configProfileCategory.upsert({
        where: { profileId_categoryId: { profileId, categoryId } },
        create: { profileId, categoryId },
        update: {},
      });
      console.log(`  Mapping: ${profileName} → ${catName}`);
    }
  }

  // 4. Upsert config entries (empty update = never overwrite existing values)
  let entryCount = 0;
  for (const [catName, entries] of Object.entries(ENTRIES_BY_CATEGORY)) {
    const categoryId = categoryIds[catName];
    for (const entry of entries) {
      await prisma.configEntry.upsert({
        where: { categoryId_key: { categoryId, key: entry.key } },
        create: {
          categoryId,
          key: entry.key,
          value: entry.defaultValue,
          encrypted: false,
          displayName: entry.displayName,
        },
        update: {},
      });
      entryCount++;
    }
    console.log(`  Entries: ${catName} (${entries.length} keys)`);
  }

  // 5. Clean up legacy usenet categories (providers now live in UsenetProvider table)
  const LEGACY_CATEGORIES = ["usenet_download", "usenet_upload"];
  for (const legacyName of LEGACY_CATEGORIES) {
    const legacy = await prisma.configCategory.findUnique({ where: { name: legacyName } });
    if (legacy) {
      // Delete entries, profile mappings, then the category itself
      await prisma.configEntry.deleteMany({ where: { categoryId: legacy.id } });
      await prisma.configProfileCategory.deleteMany({ where: { categoryId: legacy.id } });
      await prisma.configCategory.delete({ where: { id: legacy.id } });
      console.log(`  Removed legacy category: ${legacyName}`);
    }
  }

  console.log(`[seed-config] Done. ${CATEGORIES.length} categories, ${PROFILES.length} profiles, ${entryCount} entries seeded.`);
}

main()
  .catch((err) => {
    console.error("[seed-config] FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
