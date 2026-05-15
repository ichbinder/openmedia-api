import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import request from "supertest";

// Mock S3 before app import — same pattern as jellyfin.test.ts
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
// Helpers
// ---------------------------------------------------------------------------

const UPSTREAM_VERSION = "2.1.0";

async function createUser(email?: string) {
  const seed = email || `t05-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const user = await prisma.user.create({
    data: {
      email: `${seed}@test.de`,
      password: "$2b$10$hash",
      name: "T05 Test User",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

async function createPluginToken(
  userId: string,
  opts: { purpose?: string | null; revoked?: boolean; expiresInMs?: number } = {},
) {
  const { plaintext, hash, prefix } = generateApiToken();
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 365 * 24 * 60 * 60 * 1000));
  const row = await prisma.apiToken.create({
    data: {
      userId,
      tokenHash: hash,
      tokenPrefix: prefix,
      name: "Test Plugin Token",
      purpose: opts.purpose === undefined ? "jellyfin-plugin" : opts.purpose,
      revokedAt: opts.revoked ? new Date() : null,
      expiresAt,
    },
  });
  return { plaintext, id: row.id };
}

/**
 * Build a fake upstream `openmedia.zip` from GitHub Releases.
 * Contains meta.json + dummy DLL — mirrors real release artifact.
 */
async function buildFakeReleaseZip(overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const zip = new JSZip();
  const meta = {
    name: "openmedia",
    description: "openmedia plugin for Jellyfin",
    overview: "Streams your openmedia library into Jellyfin.",
    owner: "ichbinder",
    category: "General",
    guid: "8cfc3c6a-c39f-467f-8ebe-9f3218724aa1",
    targetAbi: "10.10.6.0",
    timestamp: "2026-05-14T12:00:00.0000000Z",
    changelog: `${UPSTREAM_VERSION} — Release`,
    version: UPSTREAM_VERSION,
    ...overrides,
  };
  const fixedDate = new Date("2020-01-01T00:00:00Z");
  zip.file("meta.json", JSON.stringify(meta, null, 2) + "\n", { date: fixedDate });
  zip.file("Jellyfin.Plugin.OpenMedia.dll", Buffer.from("fake-dll-content-v2"), { date: fixedDate });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  _resetJellyfinDeliveryState();
  _resetPluginSourceCache();

  const fakeZip = await buildFakeReleaseZip();
  _setGithubFetcher(async () => ({
    buffer: fakeZip,
    version: UPSTREAM_VERSION,
  }));
});

// ---------------------------------------------------------------------------
// Tests: GET /jellyfin/t/:token/plugin.zip
// ---------------------------------------------------------------------------

describe("GET /jellyfin/t/:token/plugin.zip", () => {
  it("liefert 401 wenn ?t= fehlt", async () => {
    const res = await request(app).get("/jellyfin/plugin.zip");
    expect(res.status).toBe(401);
  });

  it("liefert 401 wenn Token kein om_-Prefix hat", async () => {
    const res = await request(app).get("/jellyfin/t/invalidtoken1234567890/plugin.zip");
    expect(res.status).toBe(401);
  });

  it("liefert 401 bei Token mit falschem purpose", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id, { purpose: null });
    const res = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Jellyfin-Plugin");
  });

  it("liefert 401 bei widerrufenem Token", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id, { revoked: true });
    const res = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(res.status).toBe(401);
  });

  it("liefert 401 bei abgelaufenem Token", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id, { expiresInMs: -1000 });
    const res = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("abgelaufen");
  });

  it("liefert 200 + ZIP mit bootstrap.json fuer gueltigen Token", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app)
      .get(`/jellyfin/t/${plaintext}/plugin.zip`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toContain("openmedia-jellyfin-plugin.zip");

    const body = res.body as Buffer;
    const zip = await JSZip.loadAsync(body);
    const bootstrap = zip.file("bootstrap.json");
    expect(bootstrap).not.toBeNull();
    const parsed = JSON.parse(await bootstrap!.async("string"));
    expect(parsed.apiToken).toBe(plaintext);
    expect(parsed.apiUrl).toBeTruthy();

    // DLL bleibt erhalten
    expect(zip.file("Jellyfin.Plugin.OpenMedia.dll")).not.toBeNull();
    // meta.json bleibt erhalten
    expect(zip.file("meta.json")).not.toBeNull();
  });

  it("MD5 aus ETag stimmt mit md5 des Bodys ueberein", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app)
      .get(`/jellyfin/t/${plaintext}/plugin.zip`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    const body = res.body as Buffer;
    const md5 = createHash("md5").update(body).digest("hex");
    expect(res.headers.etag).toBe(`"${md5}"`);
  });

  it("MD5 im Manifest == MD5 des Downloads (Konsistenz-Vertrag)", async () => {
    // Set API_BASE_URL so both endpoints resolve the same base URL.
    // Without this, supertest's ephemeral ports cause different apiBaseUrl values
    // in bootstrap.json, producing different MD5s.
    const origBaseUrl = process.env.API_BASE_URL;
    process.env.API_BASE_URL = "https://api.test.local";

    try {
      const { user } = await createUser();
      const { plaintext } = await createPluginToken(user.id);

      // 1. Fetch manifest
      const manifestRes = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
      expect(manifestRes.status).toBe(200);
      const manifestMd5 = manifestRes.body[0].versions[0].checksum as string;

      // 2. Fetch download (reset delivery cache first to force fresh repack)
      _resetJellyfinDeliveryState();

      const dlRes = await request(app)
        .get(`/jellyfin/t/${plaintext}/plugin.zip`)
        .buffer(true)
        .parse((response, cb) => {
          const chunks: Buffer[] = [];
          response.on("data", (c) => chunks.push(c));
          response.on("end", () => cb(null, Buffer.concat(chunks)));
        });

      expect(dlRes.status).toBe(200);
      const body = dlRes.body as Buffer;
      const downloadMd5 = createHash("md5").update(body).digest("hex");

      expect(manifestMd5).toBe(downloadMd5);
    } finally {
      if (origBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = origBaseUrl;
    }
  });

  it("greift Rate-Limit (1/10s) — zweiter Download direkt nach erstem liefert 429", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const first = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(first.status).toBe(200);

    const second = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
  });

  it("liefert 503 wenn upstream gecachte Error hat", async () => {
    _setGithubFetcher(async () => {
      throw new Error("upstream unavailable");
    });
    _resetJellyfinDeliveryState();
    _resetPluginSourceCache();

    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    // First request triggers fetch and caches the error
    const res1 = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(res1.status).toBe(503); // fresh upstream error → 503

    // Reset delivery cache so it tries delivery again (source cache still has error)
    _resetJellyfinDeliveryState();

    const res2 = await request(app).get(`/jellyfin/t/${plaintext}/plugin.zip`);
    expect(res2.status).toBe(503); // cached upstream error → 503
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /jellyfin/repo/manifest.json (S02 integration)
// ---------------------------------------------------------------------------

describe("GET /jellyfin/repo/manifest.json (S02)", () => {
  it("liefert 200 + Manifest mit versions[] aus T03/T04 Pipeline", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].versions).toHaveLength(1);
    expect(res.body[0].versions[0].version).toBe(UPSTREAM_VERSION);
    expect(res.body[0].versions[0].targetAbi).toBe("10.10.6.0");
    expect(res.body[0].versions[0].checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sourceUrl zeigt auf /jellyfin/t/:token/plugin.zip", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(200);
    const sourceUrl = res.body[0].versions[0].sourceUrl as string;
    expect(sourceUrl).toContain("/jellyfin/t/")
    expect(sourceUrl).toContain("/plugin.zip");
    expect(sourceUrl).toContain(encodeURIComponent(plaintext));
  });

  it("liefert 503 bei gecachtem upstream Error", async () => {
    _setGithubFetcher(async () => {
      throw new Error("GitHub API rate limit exceeded");
    });
    _resetJellyfinDeliveryState();
    _resetPluginSourceCache();

    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    // First request triggers fetch and caches the error
    const res1 = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res1.status).toBe(503); // fresh upstream error also maps to 503 now

    // Reset delivery cache so it tries delivery again (source cache still has error)
    _resetJellyfinDeliveryState();

    const res2 = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res2.status).toBe(503); // cached upstream error → 503
  });

  it("Plugin-Metadaten kommen aus meta.json im Release-ZIP", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(200);
    expect(res.body[0].guid).toBe("8cfc3c6a-c39f-467f-8ebe-9f3218724aa1");
    expect(res.body[0].name).toBe("openmedia");
    expect(res.body[0].owner).toBe("ichbinder");
    expect(res.body[0].category).toBe("General");
  });

  it("MD5 Cache-Hit verhindert erneutes Repack bei wiederholtem Manifest-Abruf", async () => {
    const { user } = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    // First request — cache miss
    const res1 = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res1.status).toBe(200);
    const md5_1 = res1.body[0].versions[0].checksum;

    // Second request — should be a cache hit (same MD5, no re-fetch from GitHub)
    const res2 = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res2.status).toBe(200);
    const md5_2 = res2.body[0].versions[0].checksum;

    expect(md5_1).toBe(md5_2);
  });
});
