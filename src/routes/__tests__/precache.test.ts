import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock S3 before app import — same pattern as jellyfin.test.ts
vi.mock("../../lib/s3.js", () => ({
  isS3Configured: vi.fn(() => true),
  generatePresignedUrl: vi.fn(async () => "https://s3.example/key"),
  getFileMetadata: vi.fn(async () => ({ key: "k", size: 1, contentType: "video/mp4", lastModified: new Date(), etag: "e" })),
}));

import { createApp } from "../../app.js";
import { prisma } from "../../test/setup.js";
import { signToken } from "../../middleware/auth.js";
import { generateApiToken, hashToken } from "../../lib/api-token.js";
import { isValidTransition } from "../precache.js";

const app = createApp();

// ─── Helpers ──────────────────────────────────────────────────────────────

async function createUser(email?: string) {
  const seed = email || `precache-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: {
      email: `${seed}@test.de`,
      password: "$2b$10$hash",
      name: "Precache Test User",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

async function createPluginToken(
  userId: string,
  opts: { purpose?: string | null; revoked?: boolean; expired?: boolean } = {},
) {
  const { plaintext, hash, prefix } = generateApiToken();
  const row = await prisma.apiToken.create({
    data: {
      userId,
      tokenHash: hash,
      tokenPrefix: prefix,
      name: "Test Plugin Token",
      purpose: opts.purpose === undefined ? "jellyfin-plugin" : opts.purpose,
      revokedAt: opts.revoked ? new Date() : null,
      expiresAt: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });
  return { plaintext, id: row.id };
}

function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── State Machine Unit Tests ─────────────────────────────────────────────

describe("isValidTransition", () => {
  it("allows queued → downloading", () => {
    expect(isValidTransition("queued", "downloading")).toBe(true);
  });

  it("allows downloading → done", () => {
    expect(isValidTransition("downloading", "done")).toBe(true);
  });

  it("allows downloading → failed", () => {
    expect(isValidTransition("downloading", "failed")).toBe(true);
  });

  it("allows downloading → downloading (progress)", () => {
    expect(isValidTransition("downloading", "downloading")).toBe(true);
  });

  it("allows failed → queued (retry)", () => {
    expect(isValidTransition("failed", "queued")).toBe(true);
  });

  it("allows done → queued (re-precache)", () => {
    expect(isValidTransition("done", "queued")).toBe(true);
  });

  it("rejects queued → done (skip downloading)", () => {
    expect(isValidTransition("queued", "done")).toBe(false);
  });

  it("rejects done → downloading", () => {
    expect(isValidTransition("done", "downloading")).toBe(false);
  });

  it("allows done → release_requested", () => {
    expect(isValidTransition("done", "release_requested")).toBe(true);
  });

  it("allows release_requested → released", () => {
    expect(isValidTransition("release_requested", "released")).toBe(true);
  });

  it("rejects release_requested → done", () => {
    expect(isValidTransition("release_requested", "done")).toBe(false);
  });
});

// ─── POST /jellyfin/precache/:hash ────────────────────────────────────────

describe("POST /jellyfin/precache/:hash", () => {
  it("creates a queued precache request (201)", async () => {
    const { user, token } = await createUser();
    const hash = "abc123def456";

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}`)
      .set(authHeader(token))
      .send();

    expect(res.status).toBe(201);
    expect(res.body.state).toBe("queued");
    expect(res.body.lastEventAt).toBeTruthy();

    // Verify DB row
    const row = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId: user.id, hash } },
    });
    expect(row).toBeTruthy();
    expect(row!.state).toBe("queued");
  });

  it("is idempotent — returns existing state for queued", async () => {
    const { token } = await createUser();
    const hash = "idempotent-hash";

    const res1 = await request(app).post(`/jellyfin/precache/${hash}`).set(authHeader(token)).send();
    expect(res1.status).toBe(201);

    const res2 = await request(app).post(`/jellyfin/precache/${hash}`).set(authHeader(token)).send();
    expect(res2.status).toBe(200);
    expect(res2.body.state).toBe("queued");
  });

  it("resets done → queued on re-request", async () => {
    const { user, token } = await createUser();
    const hash = "reset-done-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "done", lastEventAt: new Date() },
    });

    const res = await request(app).post(`/jellyfin/precache/${hash}`).set(authHeader(token)).send();
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("queued");

    const row = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId: user.id, hash } },
    });
    expect(row!.state).toBe("queued");
    expect(row!.reason).toBeNull();
  });

  it("resets failed → queued on re-request", async () => {
    const { user, token } = await createUser();
    const hash = "reset-failed-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "failed", reason: "timeout", lastEventAt: new Date() },
    });

    const res = await request(app).post(`/jellyfin/precache/${hash}`).set(authHeader(token)).send();
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("queued");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/jellyfin/precache/somehash").send();
    expect(res.status).toBe(401);
  });
});

// ─── GET /jellyfin/precache/:hash ─────────────────────────────────────────

describe("GET /jellyfin/precache/:hash", () => {
  it("returns state for existing request", async () => {
    const { user, token } = await createUser();
    const hash = "get-state-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "downloading", lastEventAt: new Date(), sizeBytes: BigInt(1024), bytesDownloaded: BigInt(512) },
    });

    const res = await request(app).get(`/jellyfin/precache/${hash}`).set(authHeader(token)).send();
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("downloading");
    expect(res.body.sizeBytes).toBe("1024");
    expect(res.body.bytesDownloaded).toBe("512");
  });

  it("returns 404 when no request exists (client interprets as idle)", async () => {
    const { token } = await createUser();

    const res = await request(app).get("/jellyfin/precache/nonexistent").set(authHeader(token)).send();
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/jellyfin/precache/somehash").send();
    expect(res.status).toBe(401);
  });

  it("does not return other user's request", async () => {
    const { user: user1, token: token1 } = await createUser("user1");
    const { token: token2 } = await createUser("user2");
    const hash = "private-hash";

    await prisma.precacheRequest.create({
      data: { userId: user1.id, hash, state: "done", lastEventAt: new Date() },
    });

    const res = await request(app).get(`/jellyfin/precache/${hash}`).set(authHeader(token2)).send();
    expect(res.status).toBe(404);
  });
});

// ─── GET /jellyfin/precache/queue ─────────────────────────────────────────

describe("GET /jellyfin/precache/queue", () => {
  it("returns queued items ordered by requestedAt", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    // Create items with explicit requestedAt ordering
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "hash-older", state: "queued", lastEventAt: new Date(), requestedAt: new Date("2026-01-01") },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "hash-newer", state: "queued", lastEventAt: new Date(), requestedAt: new Date("2026-01-02") },
    });

    const res = await request(app).get("/jellyfin/precache/queue").set(authHeader(plaintext)).send();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].hash).toBe("hash-older");
    expect(res.body[1].hash).toBe("hash-newer");
  });

  it("excludes non-queued items", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "downloading-hash", state: "downloading", lastEventAt: new Date() },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "done-hash", state: "done", lastEventAt: new Date() },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "queued-hash", state: "queued", lastEventAt: new Date() },
    });

    const res = await request(app).get("/jellyfin/precache/queue").set(authHeader(plaintext)).send();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].hash).toBe("queued-hash");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/jellyfin/precache/queue").send();
    expect(res.status).toBe(401);
  });

  it("returns 401 with non-plugin token", async () => {
    const { token } = await createUser();

    const res = await request(app).get("/jellyfin/precache/queue").set(authHeader(token)).send();
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong-purpose API token", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id, { purpose: null });

    const res = await request(app).get("/jellyfin/precache/queue").set(authHeader(plaintext)).send();
    expect(res.status).toBe(401);
  });
});

// ─── POST /jellyfin/precache/:hash/status ─────────────────────────────────

describe("POST /jellyfin/precache/:hash/status", () => {
  it("transitions queued → downloading", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-trans-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "queued", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "downloading", pluginInstallId: "install-001" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("downloading");

    const row = await prisma.precacheRequest.findFirst({ where: { hash } });
    expect(row!.state).toBe("downloading");
    expect(row!.pluginInstallId).toBe("install-001");
  });

  it("transitions downloading → done", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-done-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "downloading", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "done", sizeBytes: 2048 });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("done");
  });

  it("transitions downloading → failed with reason", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-failed-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "downloading", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "failed", reason: "network_timeout" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("failed");
    expect(res.body.reason).toBe("network_timeout");
  });

  it("rejects invalid transition with 409", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-invalid-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "queued", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "done" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("queued → done");
  });

  it("returns 404 for unknown hash", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app)
      .post("/jellyfin/precache/nonexistent/status")
      .set(authHeader(plaintext))
      .send({ state: "downloading" });

    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/jellyfin/precache/somehash/status")
      .send({ state: "downloading" });

    expect(res.status).toBe(401);
  });

  it("accepts progress update (downloading → downloading)", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-progress-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "downloading", lastEventAt: new Date(), sizeBytes: BigInt(2048) },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "downloading", bytesDownloaded: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("downloading");

    const row = await prisma.precacheRequest.findFirst({ where: { hash } });
    expect(row!.bytesDownloaded).toBe(BigInt(1024));
  });

  it("returns 400 when state is missing", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-no-state";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "queued", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({});

    expect(res.status).toBe(400);
  });

  it("accepts release_requested → released transition", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);
    const hash = "status-released-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "release_requested", lastEventAt: new Date() },
    });

    const res = await request(app)
      .post(`/jellyfin/precache/${hash}/status`)
      .set(authHeader(plaintext))
      .send({ state: "released" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("released");

    const row = await prisma.precacheRequest.findFirst({ where: { hash } });
    expect(row!.state).toBe("released");
  });
});

// ─── DELETE /jellyfin/precache/:hash ──────────────────────────────────────

describe("DELETE /jellyfin/precache/:hash", () => {
  it("transitions done → release_requested (200)", async () => {
    const { user, token } = await createUser();
    const hash = "delete-done-hash";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "done", lastEventAt: new Date() },
    });

    const res = await request(app)
      .delete(`/jellyfin/precache/${hash}`)
      .set(authHeader(token))
      .send();

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("release_requested");
    expect(res.body.lastEventAt).toBeTruthy();

    const row = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId: user.id, hash } },
    });
    expect(row!.state).toBe("release_requested");
  });

  it("returns 404 for unknown hash", async () => {
    const { token } = await createUser();

    const res = await request(app)
      .delete("/jellyfin/precache/nonexistent-hash")
      .set(authHeader(token))
      .send();

    expect(res.status).toBe(404);
  });

  it("returns 404 when requesting another user's precache", async () => {
    const { user: user1 } = await createUser("delete-user1");
    const { token: token2 } = await createUser("delete-user2");
    const hash = "delete-other-user-hash";

    await prisma.precacheRequest.create({
      data: { userId: user1.id, hash, state: "done", lastEventAt: new Date() },
    });

    const res = await request(app)
      .delete(`/jellyfin/precache/${hash}`)
      .set(authHeader(token2))
      .send();

    expect(res.status).toBe(404);
  });

  it("returns 409 when state does not allow release", async () => {
    const { user, token } = await createUser();
    const hash = "delete-invalid-state";

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash, state: "downloading", lastEventAt: new Date() },
    });

    const res = await request(app)
      .delete(`/jellyfin/precache/${hash}`)
      .set(authHeader(token))
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("downloading");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app)
      .delete("/jellyfin/precache/somehash")
      .send();

    expect(res.status).toBe(401);
  });
});

// ─── GET /jellyfin/precache/release-queue ─────────────────────────────────

describe("GET /jellyfin/precache/release-queue", () => {
  it("returns release_requested items ordered by lastEventAt", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "release-older", state: "release_requested", lastEventAt: new Date("2026-01-01") },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "release-newer", state: "release_requested", lastEventAt: new Date("2026-01-02") },
    });

    const res = await request(app).get("/jellyfin/precache/release-queue").set(authHeader(plaintext)).send();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].hash).toBe("release-older");
    expect(res.body[1].hash).toBe("release-newer");
  });

  it("excludes non-release_requested items", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "done-hash", state: "done", lastEventAt: new Date() },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "queued-hash", state: "queued", lastEventAt: new Date() },
    });
    await prisma.precacheRequest.create({
      data: { userId: user.id, hash: "release-hash", state: "release_requested", lastEventAt: new Date() },
    });

    const res = await request(app).get("/jellyfin/precache/release-queue").set(authHeader(plaintext)).send();
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].hash).toBe("release-hash");
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/jellyfin/precache/release-queue").send();
    expect(res.status).toBe(401);
  });

  it("returns 401 with non-plugin token", async () => {
    const { token } = await createUser();

    const res = await request(app).get("/jellyfin/precache/release-queue").set(authHeader(token)).send();
    expect(res.status).toBe(401);
  });
});
