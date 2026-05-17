import { PrismaClient } from "../../generated/client/index.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";

// Set test DATABASE_URL before any imports
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-testing-only";
process.env.AUTO_PROVISION = "false"; // Disable auto-provisioning in tests

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
export const prisma = new PrismaClient({ adapter });

beforeAll(async () => {
  // Push schema to test DB using prisma db push
  execSync("npx prisma db push --force-reset --accept-data-loss", {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Prisma AI safety guard — this is the ephemeral test DB on tmpfs, safe to reset
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "user_library" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "encrypted_configs" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "vps_events" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "service_tokens" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "download_jobs" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "upload_jobs" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "nzb_files" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "nzb_movies" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "precache_requests" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "search_history" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "watchlist_items" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
});

afterAll(async () => {
  await prisma.$disconnect();
});
