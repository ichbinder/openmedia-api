import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { signMediaUrl } from "../../lib/media-url-signer.js";

// ---------------------------------------------------------------------------
// Mock S3 before app import — same pattern as jellyfin.test.ts
// ---------------------------------------------------------------------------
vi.mock("../../lib/s3.js", () => ({
  isS3Configured: vi.fn(() => true),
  generatePresignedUrl: vi.fn(
    async (key: string, ttl?: number, opts?: { bucket?: string; responseContentType?: string }) =>
      `https://s3.example/${opts?.bucket ?? "default"}/${key}?expires=${ttl ?? 0}`,
  ),
  getFileMetadata: vi.fn(async (key: string) => ({
    key,
    size: 1234,
    contentType: "video/mp4",
    lastModified: new Date(),
    etag: "etag",
  })),
}));

// Capture structured log output for assertion
const logCapture = vi.fn();
const origConsoleLog = console.log;
const origConsoleError = console.error;

import { createApp } from "../../app.js";
import { prisma } from "../../test/setup.js";
import { signToken } from "../../middleware/auth.js";
import { generateApiToken, hashToken } from "../../lib/api-token.js";
import {
  _resetPluginSourceCache,
  _setGithubFetcher,
} from "../../lib/jellyfin-plugin-source.js";
import {
  _resetJellyfinDeliveryState,
} from "../jellyfin.js";

const app = createApp();

// ---------------------------------------------------------------------------
// Test secret — must be ≥ 32 chars
// ---------------------------------------------------------------------------
const MEDIA_SIGNING_SECRET = "test-signing-secret-that-is-at-least-32-characters-long";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(email?: string) {
  const seed = email || `signed-url-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: {
      email: `${seed}@test.de`,
      password: "$2b$10$hash",
      name: "Signed URL Test User",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

async function createPluginToken(userId: string) {
  const { plaintext, hash, prefix } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      userId,
      tokenHash: hash,
      tokenPrefix: prefix,
      name: "Test Plugin Token",
      purpose: "jellyfin-plugin",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  return { plaintext, id: row.id };
}

async function seedNzbFile(hash: string, userId: string) {
  // Create movie (model is NzbMovie, accessed as prisma.nzbMovie)
  const movie = await prisma.nzbMovie.create({
    data: {
      tmdbId: Math.floor(Math.random() * 1000000) + 1,
      titleDe: "Testfilm",
      titleEn: "Test Movie",
      year: 2024,
    },
  });

  // Create NzbFile with S3 keys
  const nzbFile = await prisma.nzbFile.create({
    data: {
      hash,
      originalFilename: `${hash}.mp4`,
      s3Key: `movies/${hash}.mp4`,
      s3StreamKey: `streams/${hash}.mp4`,
      s3Bucket: "test-bucket",
      fileExtension: ".mp4",
      movieId: movie.id,
    },
  });

  // Create UserLibrary entry
  await prisma.userLibrary.create({
    data: {
      userId,
      nzbFileId: nzbFile.id,
    },
  });

  return nzbFile;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  logCapture.mockClear();
  console.log = (...args: unknown[]) => {
    logCapture(...args);
  };
  console.error = (...args: unknown[]) => {
    // suppress error output in tests
  };
  _resetJellyfinDeliveryState();
  _resetPluginSourceCache();

  // Set MEDIA_SIGNING_SECRET in env for this test
  process.env.MEDIA_SIGNING_SECRET = MEDIA_SIGNING_SECRET;
});

afterEach(() => {
  console.log = origConsoleLog;
  console.error = origConsoleError;
  delete process.env.MEDIA_SIGNING_SECRET;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /jellyfin/stream/:hash — signed URL auth", () => {
  it("valid signed URL → 302 to presigned S3", async () => {
    const { user } = await createUser();
    const hash = "abcdef1234567890";
    await seedNzbFile(hash, user.id);

    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: MEDIA_SIGNING_SECRET,
    });

    const res = await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("s3.example");

    // Verify structured log
    const authLog = logCapture.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("stream:auth"),
    );
    expect(authLog).toBeDefined();
    const logObj = authLog![1] as Record<string, unknown>;
    expect(logObj.mode).toBe("signed");
    expect(logObj.userId).toBe(user.id.slice(0, 8));
  });

  it("expired signed URL → 401 with reason=expired", async () => {
    const { user } = await createUser();
    const hash = "expired1234567890";
    await seedNzbFile(hash, user.id);

    // Sign with 1-second TTL, then wait to expire
    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: MEDIA_SIGNING_SECRET,
      ttlSeconds: 1,
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_signature");
    expect(res.body.reason).toBe("expired");

    // Verify failure log
    const failLog = logCapture.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("stream:auth_failed"),
    );
    expect(failLog).toBeDefined();
    const logObj = failLog![1] as Record<string, unknown>;
    expect(logObj.reason).toBe("expired");
  });

  it("tampered hash with valid sig → 401 with reason=tampered", async () => {
    const { user } = await createUser();
    const hash = "original12345678";
    await seedNzbFile(hash, user.id);

    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: MEDIA_SIGNING_SECRET,
    });

    // Use a different hash but same sig/exp/u
    const tamperedHash = "tampered99999999";
    const res = await request(app).get(
      `/jellyfin/stream/${tamperedHash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_signature");
    expect(res.body.reason).toBe("tampered");
  });

  it("unknown user (u not in DB) → 404 (not 401, to avoid leaking hash existence)", async () => {
    const { user } = await createUser();
    const hash = "unknown123456789";
    await seedNzbFile(hash, user.id);

    // Sign with a userId that doesn't exist in DB
    const fakeUserId = "nonexistent-user-id-12345";
    const signed = signMediaUrl({
      hash,
      userId: fakeUserId,
      secret: MEDIA_SIGNING_SECRET,
    });

    const res = await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    // Signed URL verifies ok (sig is valid), but the stream handler then checks
    // library access — user has no library entry → 404.
    // Actually, the user lookup in the stream handler uses req.user.userId which
    // is the fake user, so it won't find a library entry → 404.
    expect(res.status).toBe(404);
  });

  it("old ?token= path with real om_ token still → 302", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "tokenpath123456789";
    await seedNzbFile(hash, user.id);

    const res = await request(app).get(
      `/jellyfin/stream/${hash}?token=${plaintext}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("s3.example");
  });

  it("sig + token mixed → signed URL wins", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "mixedauth123456789";
    await seedNzbFile(hash, user.id);

    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: MEDIA_SIGNING_SECRET,
    });

    // Both sig params and token present — signed URL should take precedence
    const res = await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}&token=${plaintext}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("s3.example");

    // Verify it used signed mode, not query/token mode
    const authLog = logCapture.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("stream:auth"),
    );
    expect(authLog).toBeDefined();
    const logObj = authLog![1] as Record<string, unknown>;
    expect(logObj.mode).toBe("signed");
  });

  it("no secrets in log output", async () => {
    const { user } = await createUser();
    const hash = "nologsecret12345";
    await seedNzbFile(hash, user.id);

    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: MEDIA_SIGNING_SECRET,
    });

    await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    // Collect all log output as string
    const allLogs = logCapture.mock.calls
      .map((call: unknown[]) => call.map((a: unknown) => String(a)).join(" "))
      .join("\n");

    // The signing secret must never appear in logs
    expect(allLogs).not.toContain(MEDIA_SIGNING_SECRET);

    // Full sig value must not appear in logs (only prefix is ok)
    expect(allLogs).not.toContain(signed.sig);
  });

  it("missing MEDIA_SIGNING_SECRET → 500", async () => {
    const { user } = await createUser();
    const hash = "nosecret123456789";
    await seedNzbFile(hash, user.id);

    // Remove the signing secret
    delete process.env.MEDIA_SIGNING_SECRET;

    const signed = signMediaUrl({
      hash,
      userId: user.id,
      secret: "another-secret-that-is-at-least-32-characters!", // sign with different secret
    });

    const res = await request(app).get(
      `/jellyfin/stream/${hash}?sig=${signed.sig}&exp=${signed.exp}&u=${signed.u}`,
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Konfiguration");

    // Verify failure log
    const failLog = logCapture.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("stream:auth_failed"),
    );
    expect(failLog).toBeDefined();
    const logObj = failLog![1] as Record<string, unknown>;
    expect(logObj.reason).toBe("no_secret");
  });
});
