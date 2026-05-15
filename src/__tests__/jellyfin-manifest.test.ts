import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { generateApiToken } from "../lib/api-token.js";
import {
  buildJellyfinManifest,
  buildPersonalizedPluginZip,
  _resetJellyfinManifestCache,
  _setJellyfinUpstreamFetcher,
} from "../lib/jellyfin-manifest.js";
import {
  _resetPluginSourceCache,
  _setGithubFetcher,
} from "../lib/jellyfin-plugin-source.js";
import {
  _resetJellyfinDeliveryState,
} from "../routes/jellyfin.js";

const app = createApp();

const UPSTREAM_VERSION = "1.2.3.4";

async function createUser(emailSeed?: string) {
  const seed = emailSeed || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.user.create({
    data: {
      email: `jfmanifest-${seed}@test.de`,
      password: "$2b$10$hash",
      name: "Jellyfin Manifest Test",
    },
  });
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
 * Build a fake upstream `openmedia.zip` for tests:
 *   - meta.json with controlled fields
 *   - tiny dummy DLL blob
 *   - thumb.png placeholder
 */
async function buildFakeUpstreamZip(overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const zip = new JSZip();
  const meta = {
    name: "openmedia",
    description: "openmedia plugin",
    overview: "openmedia overview",
    owner: "ichbinder",
    category: "General",
    guid: "8cfc3c6a-c39f-467f-8ebe-9f3218724aa1",
    imageUrl: "https://example.com/thumb.png",
    targetAbi: "10.11.5.0",
    timestamp: "2026-05-14T12:00:00.0000000Z",
    changelog: `${UPSTREAM_VERSION} - Release`,
    version: UPSTREAM_VERSION,
    ...overrides,
  };
  // Use a fixed date so the input ZIP itself is reproducible across test runs.
  const fixedDate = new Date("2020-01-01T00:00:00Z");
  zip.file("meta.json", JSON.stringify(meta, null, 2) + "\n", { date: fixedDate });
  zip.file("Jellyfin.Plugin.OpenMedia.dll", Buffer.from("fake-dll-content"), { date: fixedDate });
  zip.file("thumb.png", Buffer.from("89504e470d0a1a0a", "hex"), { date: fixedDate });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

let envBackup: Record<string, string | undefined> = {};
const envKeys = ["JELLYFIN_PLUGIN_DIST_BASE_URL", "JELLYFIN_PLUGIN_DIST_REPO", "JELLYFIN_PLUGIN_DIST_BRANCH"];

beforeEach(async () => {
  envBackup = {};
  for (const k of envKeys) envBackup[k] = process.env[k];

  const fakeZip = await buildFakeUpstreamZip();
  _setJellyfinUpstreamFetcher(async (path) => {
    if (path === "version.txt") return UPSTREAM_VERSION;
    return fakeZip;
  });

  // T03 GitHub Release fetcher (used by S02 manifest/download endpoints)
  _resetPluginSourceCache();
  _setGithubFetcher(async () => ({
    buffer: fakeZip,
    version: UPSTREAM_VERSION,
  }));
  _resetJellyfinDeliveryState();
});

afterEach(() => {
  _setJellyfinUpstreamFetcher(null);
  _resetJellyfinManifestCache();
  _setGithubFetcher(null);
  _resetPluginSourceCache();
  _resetJellyfinDeliveryState();
  for (const k of envKeys) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe("buildJellyfinManifest()", () => {
  it("liefert ein Plugin-Entry mit Daten aus upstream meta.json", async () => {
    const manifest = await buildJellyfinManifest({
      apiBaseUrl: "https://api.example.com",
      apiToken: "om_testTokenWithEnoughLength123456",
    });

    expect(manifest).toHaveLength(1);
    expect(manifest[0].guid).toBe("8cfc3c6a-c39f-467f-8ebe-9f3218724aa1");
    expect(manifest[0].name).toBe("openmedia");
    expect(manifest[0].versions).toHaveLength(1);
    expect(manifest[0].versions[0].version).toBe(UPSTREAM_VERSION);
    expect(manifest[0].versions[0].targetAbi).toBe("10.11.5.0");
    expect(manifest[0].versions[0].sourceUrl).toBe(
      "https://api.example.com/jellyfin/plugin.zip?t=om_testTokenWithEnoughLength123456",
    );
    expect(manifest[0].versions[0].checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  it("checksum stimmt mit md5 der personalisierten zip ueberein (manifest <-> plugin.zip Vertrag)", async () => {
    const apiBaseUrl = "https://api.example.com";
    const apiToken = "om_consistencyTestToken1234567890";

    const manifest = await buildJellyfinManifest({ apiBaseUrl, apiToken });
    _resetJellyfinManifestCache();

    const { buffer } = await buildPersonalizedPluginZip({ apiBaseUrl, apiToken });
    const md5 = createHash("md5").update(buffer).digest("hex");

    expect(manifest[0].versions[0].checksum).toBe(md5);
  });

  it("injizierte bootstrap.json enthaelt apiUrl + apiToken", async () => {
    const apiBaseUrl = "https://api.example.com";
    const apiToken = "om_bootstrapInjectionTest12345678";

    const { buffer } = await buildPersonalizedPluginZip({ apiBaseUrl, apiToken });
    const zip = await JSZip.loadAsync(buffer);
    const bootstrap = zip.file("bootstrap.json");
    expect(bootstrap).not.toBeNull();
    const content = await bootstrap!.async("string");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ apiUrl: apiBaseUrl, apiToken });
  });
});

describe("GET /jellyfin/repo/manifest.json", () => {
  it("liefert 401 wenn ?t= fehlt", async () => {
    const res = await request(app).get("/jellyfin/repo/manifest.json");
    expect(res.status).toBe(401);
  });

  it("liefert 401 wenn Token kein om_-Prefix hat", async () => {
    const res = await request(app).get("/jellyfin/repo/manifest.json?t=invalidtoken1234567890");
    expect(res.status).toBe(401);
  });

  it("liefert 401 wenn Token unbekannt ist", async () => {
    const res = await request(app).get(
      "/jellyfin/repo/manifest.json?t=om_dieserTokenExistiertNichtUndIstTotalFalschABCDEFG",
    );
    expect(res.status).toBe(401);
  });

  it("liefert 200 + valides Manifest mit gueltigem Plugin-Token", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].guid).toBeDefined();
    expect(res.body[0].versions[0].version).toBe(UPSTREAM_VERSION);
    expect(res.body[0].versions[0].sourceUrl).toContain(`/jellyfin/plugin/download?t=${plaintext}`);
    expect(res.body[0].versions[0].checksum).toMatch(/^[0-9a-f]{32}$/);
  });

  it("liefert 401 fuer Token mit falschem purpose", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id, { purpose: null });

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Jellyfin-Plugin");
  });

  it("liefert 401 fuer widerrufenen Token", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id, { revoked: true });

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("widerrufen");
  });

  it("liefert 401 fuer abgelaufenen Token", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id, { expiresInMs: -1000 });

    const res = await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("abgelaufen");
  });

  it("aktualisiert lastUsedAt bei erfolgreichem Manifest-Abruf", async () => {
    const user = await createUser();
    const { plaintext, id } = await createPluginToken(user.id);

    await request(app).get(`/jellyfin/repo/manifest.json?t=${plaintext}`);

    let dbToken;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      dbToken = await prisma.apiToken.findUnique({ where: { id } });
      if (dbToken?.lastUsedAt) break;
    }
    expect(dbToken?.lastUsedAt).not.toBeNull();
  });
});

describe("GET /jellyfin/plugin.zip", () => {
  it("liefert 401 wenn ?t= fehlt", async () => {
    const res = await request(app).get("/jellyfin/plugin.zip");
    expect(res.status).toBe(401);
  });

  it("liefert 401 fuer Token mit falschem purpose", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id, { purpose: null });
    const res = await request(app).get(`/jellyfin/plugin.zip?t=${plaintext}`);
    expect(res.status).toBe(401);
  });

  it("liefert 200 + ZIP mit bootstrap.json fuer gueltigen Token", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app)
      .get(`/jellyfin/plugin.zip?t=${plaintext}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks: Buffer[] = [];
        response.on("data", (c) => chunks.push(c));
        response.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = res.body as Buffer;
    const zip = await JSZip.loadAsync(body);
    const bootstrap = zip.file("bootstrap.json");
    expect(bootstrap).not.toBeNull();
    const parsed = JSON.parse(await bootstrap!.async("string"));
    expect(parsed.apiToken).toBe(plaintext);
    expect(parsed.apiUrl).toBeTruthy();

    // DLL bleibt erhalten.
    expect(zip.file("Jellyfin.Plugin.OpenMedia.dll")).not.toBeNull();
  });

  it("MD5 aus ETag matched md5 des Bodys", async () => {
    const user = await createUser();
    const { plaintext } = await createPluginToken(user.id);

    const res = await request(app)
      .get(`/jellyfin/plugin.zip?t=${plaintext}`)
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
});
