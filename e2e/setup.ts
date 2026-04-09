import { beforeAll, afterAll, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { Server } from "http";

const API_PORT = Number(process.env.E2E_PORT || 4444);
export const BASE_URL = `http://localhost:${API_PORT}`;

let server: Server;

beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "e2e-test-secret";
  process.env.AUTO_PROVISION = "false";
  process.env.ENABLE_TEST_ENDPOINTS = "1";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test";

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

  // Start real server
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(API_PORT, () => {
      console.log(`[e2e] API running on ${BASE_URL}`);
      resolve();
    });
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
  // Clean all tables between test files via the /test/cleanup endpoint
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
