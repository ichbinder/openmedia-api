import { beforeAll, afterAll, beforeEach } from "vitest";
import type { Server } from "http";

const API_PORT = parseInt(process.env.E2E_PORT || "4444", 10) || 4444;
export const BASE_URL = `http://localhost:${API_PORT}`;

let server: Server;

beforeAll(async () => {
  // Set test environment before any app imports
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-test-secret";
  process.env.AUTO_PROVISION = "false";
  process.env.ENABLE_TEST_ENDPOINTS = "1";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test";

  // Safety guard: refuse to run --force-reset against anything other than the expected test DB
  const parsed = new URL(process.env.DATABASE_URL);
  const dbName = parsed.pathname.replace(/^\//, "");
  const allowedHosts = new Set(["localhost", "127.0.0.1"]);
  const isExpectedDb =
    allowedHosts.has(parsed.hostname) &&
    parsed.port === "5433" &&
    dbName === "cinescope_test";

  if (!isExpectedDb) {
    throw new Error(
      `DATABASE_URL does not look like the test database — refusing to --force-reset: ${process.env.DATABASE_URL.replace(/\/\/.*@/, "//***@")}`,
    );
  }

  // Push schema to test DB (localhost:5433 tmpfs container — not production)
  const { execSync } = await import("child_process");
  execSync("npx prisma db push --force-reset --accept-data-loss", {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // Prisma AI safety guard — this is the ephemeral test DB on tmpfs, safe to reset
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  // Defer app import so prisma reads DATABASE_URL after it's set
  const { createApp } = await import("../src/app.js");

  // Start real server
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(API_PORT, () => {
      console.log(`[e2e] API running on ${BASE_URL}`);
      resolve();
    });
    server.on("error", (err) => reject(err));
  });

  // Wait for health check
  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok" && body.db === "connected") {
        console.log("[e2e] Health check passed — DB connected");
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API failed to start or DB not connected after 10s");
});

beforeEach(async () => {
  // Clean all tables between each test via the /test/cleanup endpoint
  const res = await fetch(`${BASE_URL}/test/cleanup`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Test cleanup failed: ${res.status} ${await res.text()}`);
  }
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    console.log("[e2e] Server stopped");
  }

  // Disconnect prisma
  const prisma = (await import("../src/lib/prisma.js")).default;
  await prisma.$disconnect();
});
