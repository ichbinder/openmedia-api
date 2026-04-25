import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import {
  generateServiceToken,
  storeServiceToken,
} from "../lib/service-token.js";
import type { VpnConfigResolved } from "../lib/vpn-config.js";

// vi.hoisted runs before vi.mock hoisting — safe to reference in factories
const { mockDeleteServer } = vi.hoisted(() => ({
  mockDeleteServer: vi.fn().mockResolvedValue(undefined),
}));

// Mock Hetzner — auto-upload and upload completion use dynamic imports
vi.mock("../lib/hetzner.js", () => ({
  isHetznerConfigured: vi.fn().mockReturnValue(true),
  provisionUploadVps: vi.fn().mockResolvedValue({
    server: { id: 42, name: "mock-upload-vps", publicIpv4: "10.0.0.42" },
  }),
  deleteServer: mockDeleteServer,
  createServer: vi.fn().mockResolvedValue({
    server: { id: 99, name: "mock-dl-vps", publicIpv4: "10.0.0.99" },
  }),
}));

// Mock VPS configs — bootstrap returns these to VPS instances
vi.mock("../lib/vps-config.js", () => ({
  getDownloadVpsConfig: vi.fn().mockResolvedValue({
    apiBaseUrl: "http://localhost:4000",
    s3AccessKey: "test-s3-key",
    s3SecretKey: "test-s3-secret",
    s3Endpoint: "https://hel1.s3.example.com",
    s3Bucket: "test-bucket",
    s3Region: "hel1",
    nzbServiceUrl: "http://nzb.example.com",
    dockerImage: "ghcr.io/test/downloader:latest",
    usenetServers: [
      { host: "news.example.com", username: "user", password: "pass" },
    ],
  }),
  getUploadVpsConfig: vi.fn().mockResolvedValue({
    apiBaseUrl: "http://localhost:4000",
    s3AccessKey: "test-upload-s3-key",
    s3SecretKey: "test-upload-s3-secret",
    s3Endpoint: "https://hel1.s3.example.com",
    s3Bucket: "test-upload-bucket",
    nzbServiceUrl: "http://nzb.example.com",
    nzbServiceToken: "test-nzb-token",
    dockerImage: "ghcr.io/test/uploader:latest",
    usenetProviders: [
      {
        host: "news1.example.com",
        port: 563,
        username: "upuser1",
        password: "uppass1",
        ssl: true,
        connections: 20,
      },
    ],
  }),
}));

const app = createApp();

// Auth helper — creates a unique test user and returns Bearer token
let emailCounter = 500;
async function getAuthToken() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({
      email: `e2e-${emailCounter}-${Date.now()}@test.de`,
      password: "test123",
      name: "E2E User",
    });
  return res.body.token as string;
}

describe("E2E roundtrip: download → upload → cleanup", () => {
  it("completes the full lifecycle with token + VPS cleanup", async () => {
    // ── 1. Setup: register user, create NzbMovie + NzbFile (source=external) ──
    const token = await getAuthToken();

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Roundtrip Film", titleEn: "Roundtrip Movie", year: 2025 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash: `rt-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        originalFilename: "Roundtrip.Movie.2025.1080p.BluRay.x264.nzb",
        resolution: "1080p",
        source: "external",
      },
    });

    // ── 2. Create download job (queued) ──
    const dlJob = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });

    // ── 3. Simulate download VPS provisioning: store a service token ──
    const dlToken = generateServiceToken();
    await storeServiceToken(dlToken.hash, dlJob.id, "download");

    // ── 4. Bootstrap call for download — VPS fetches its config ──
    const bootstrapRes = await request(app)
      .get(`/service/jobs/${dlJob.id}/bootstrap`)
      .set("Authorization", `Bearer ${dlToken.plaintext}`);

    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.body.job.id).toBe(dlJob.id);
    expect(bootstrapRes.body.job.hash).toBe(nzbFile.hash);
    expect(bootstrapRes.body.config.s3AccessKey).toBeDefined();
    expect(bootstrapRes.body.config.usenetServers).toBeDefined();

    // ── 5. Walk download through valid status transitions ──
    // queued → provisioning → downloading → uploading → completed
    const patchStatus = async (status: string, extra?: Record<string, unknown>) => {
      const res = await request(app)
        .patch(`/downloads/jobs/${dlJob.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status, ...extra });
      return res;
    };

    let res = await patchStatus("provisioning");
    expect(res.status).toBe(200);

    res = await patchStatus("downloading");
    expect(res.status).toBe(200);

    res = await patchStatus("uploading");
    expect(res.status).toBe(200);

    // completed requires s3Key + s3Bucket — this triggers auto-upload
    res = await patchStatus("completed", {
      s3Key: "downloads/roundtrip-test.mkv",
      s3Bucket: "test-bucket",
    });
    expect(res.status).toBe(200);

    // ── 6. Verify auto-upload created an upload job ──
    const uploadJob = await prisma.uploadJob.findFirst({
      where: { nzbFileId: nzbFile.id },
    });
    expect(uploadJob).not.toBeNull();
    expect(uploadJob!.hetznerServerId).toBe(42); // from mock provisionUploadVps

    // Auto-upload also stored a service token — verify it exists
    const autoTokenCount = await prisma.serviceToken.count({
      where: { jobId: uploadJob!.id },
    });
    expect(autoTokenCount).toBeGreaterThanOrEqual(1);

    // ── 7. Create our own upload service token (we need the plaintext for bootstrap) ──
    const ulToken = generateServiceToken();
    await storeServiceToken(ulToken.hash, uploadJob!.id, "upload");

    // ── 8. Bootstrap call for upload — VPS fetches its config ──
    const ulBootstrapRes = await request(app)
      .get(`/service/jobs/${uploadJob!.id}/bootstrap`)
      .set("Authorization", `Bearer ${ulToken.plaintext}`);

    expect(ulBootstrapRes.status).toBe(200);
    expect(ulBootstrapRes.body.job.id).toBe(uploadJob!.id);
    expect(ulBootstrapRes.body.job.s3Key).toBe("downloads/roundtrip-test.mkv");
    expect(ulBootstrapRes.body.config.s3AccessKey).toBeDefined();
    expect(ulBootstrapRes.body.config.usenetProviders).toBeDefined();

    // ── 9. Upload completion — auto-upload already set status=running ──
    // Verify the upload job is already running (set by auto-upload provisioning)
    const freshUpload = await prisma.uploadJob.findUnique({ where: { id: uploadJob!.id } });
    expect(freshUpload!.status).toBe("running");

    // completed triggers deleteServer + deleteServiceTokens
    res = await request(app)
      .patch(`/uploads/${uploadJob!.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "completed" });
    expect(res.status).toBe(200);

    // ── 10. Verify VPS deleted ──
    expect(mockDeleteServer).toHaveBeenCalledWith(42);

    // ── 11. Verify upload service tokens cleaned from DB ──
    const remainingUploadTokens = await prisma.serviceToken.count({
      where: { jobId: uploadJob!.id },
    });
    expect(remainingUploadTokens).toBe(0);

    // Download token should still exist (cleaned by separate download cleanup path)
    const remainingDlTokens = await prisma.serviceToken.count({
      where: { jobId: dlJob.id },
    });
    expect(remainingDlTokens).toBe(1);
  });

  it("completes full lifecycle with VPN provider", async () => {
    // VPN config matching VpnConfigResolved shape
    const mockVpnConfig: VpnConfigResolved = {
      providerId: "vpn-e2e-1",
      providerName: "E2E-VPN",
      protocol: "wireguard",
      configBlob:
        "[Interface]\nPrivateKey=test\n[Peer]\nAllowedIPs=0.0.0.0/1, 128.0.0.0/1",
      allowedIPs: ["0.0.0.0/1", "128.0.0.0/1"],
      excludedCIDRs: ["169.254.169.254/32"],
      username: null,
      password: null,
    };

    // Override mocks to include vpnConfig for this test
    const { getDownloadVpsConfig, getUploadVpsConfig } = await import(
      "../lib/vps-config.js"
    );
    vi.mocked(getDownloadVpsConfig).mockResolvedValueOnce({
      apiBaseUrl: "http://localhost:4000",
      s3AccessKey: "test-s3-key",
      s3SecretKey: "test-s3-secret",
      s3Endpoint: "https://hel1.s3.example.com",
      s3Bucket: "test-bucket",
      s3Region: "hel1",
      nzbServiceUrl: "http://nzb.example.com",
      dockerImage: "ghcr.io/test/downloader:latest",
      usenetServers: [
        { host: "news.example.com", username: "user", password: "pass" },
      ],
      vpnConfig: mockVpnConfig,
      routingPolicy: null,
    });
    // Called twice: once during auto-upload provisioning (downloads.ts),
    // once during upload bootstrap (service-api.ts)
    const uploadConfigWithVpn = {
      apiBaseUrl: "http://localhost:4000",

      s3AccessKey: "test-upload-s3-key",
      s3SecretKey: "test-upload-s3-secret",
      s3Endpoint: "https://hel1.s3.example.com",
      s3Bucket: "test-upload-bucket",
      nzbServiceUrl: "http://nzb.example.com",
      nzbServiceToken: "test-nzb-token",
      dockerImage: "ghcr.io/test/uploader:latest",
      usenetProviders: [
        {
          host: "news1.example.com",
          port: 563,
          username: "upuser1",
          password: "uppass1",
          ssl: true,
          connections: 20,
        },
      ],
      vpnConfig: mockVpnConfig,
      routingPolicy: null,
    };
    vi.mocked(getUploadVpsConfig)
      .mockResolvedValueOnce(uploadConfigWithVpn)
      .mockResolvedValueOnce(uploadConfigWithVpn);

    // ── 1. Setup ──
    const token = await getAuthToken();

    const movie = await prisma.nzbMovie.create({
      data: {
        titleDe: "VPN Roundtrip Film",
        titleEn: "VPN Roundtrip Movie",
        year: 2026,
      },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash: `vpn-rt-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        originalFilename: "VPN.Roundtrip.2026.1080p.BluRay.x264.nzb",
        resolution: "1080p",
        source: "external",
      },
    });

    // ── 2. Create download job ──
    const dlJob = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });

    // ── 3. Service token for download VPS ──
    const dlToken = generateServiceToken();
    await storeServiceToken(dlToken.hash, dlJob.id, "download");

    // ── 4. Bootstrap call for download — verify vpnConfig present ──
    const bootstrapRes = await request(app)
      .get(`/service/jobs/${dlJob.id}/bootstrap`)
      .set("Authorization", `Bearer ${dlToken.plaintext}`);

    expect(bootstrapRes.status).toBe(200);
    expect(bootstrapRes.body.job.id).toBe(dlJob.id);
    expect(bootstrapRes.body.config.s3AccessKey).toBeDefined();
    // VPN assertions
    expect(bootstrapRes.body.vpnConfig).toBeDefined();
    expect(bootstrapRes.body.vpnConfig.protocol).toBe("wireguard");
    expect(bootstrapRes.body.vpnConfig.configBlob).toContain("[Interface]");
    expect(bootstrapRes.body.vpnConfig.excludedCIDRs).toEqual(
      expect.arrayContaining(["169.254.169.254/32"]),
    );

    // ── 5. Walk download through status transitions ──
    const patchStatus = async (
      status: string,
      extra?: Record<string, unknown>,
    ) => {
      const res = await request(app)
        .patch(`/downloads/jobs/${dlJob.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status, ...extra });
      return res;
    };

    let res = await patchStatus("provisioning");
    expect(res.status).toBe(200);

    res = await patchStatus("downloading");
    expect(res.status).toBe(200);

    res = await patchStatus("uploading");
    expect(res.status).toBe(200);

    // completed triggers auto-upload
    res = await patchStatus("completed", {
      s3Key: "downloads/vpn-roundtrip-test.mkv",
      s3Bucket: "test-bucket",
    });
    expect(res.status).toBe(200);

    // ── 6. Verify auto-upload created an upload job ──
    const uploadJob = await prisma.uploadJob.findFirst({
      where: { nzbFileId: nzbFile.id },
    });
    expect(uploadJob).not.toBeNull();
    expect(uploadJob!.hetznerServerId).toBe(42);

    // ── 7. Upload bootstrap — verify vpnConfig present ──
    const ulToken = generateServiceToken();
    await storeServiceToken(ulToken.hash, uploadJob!.id, "upload");

    const ulBootstrapRes = await request(app)
      .get(`/service/jobs/${uploadJob!.id}/bootstrap`)
      .set("Authorization", `Bearer ${ulToken.plaintext}`);

    expect(ulBootstrapRes.status).toBe(200);
    expect(ulBootstrapRes.body.job.id).toBe(uploadJob!.id);
    expect(ulBootstrapRes.body.config.usenetProviders).toBeDefined();
    // VPN assertions on upload bootstrap
    expect(ulBootstrapRes.body.vpnConfig).toBeDefined();
    expect(ulBootstrapRes.body.vpnConfig.protocol).toBe("wireguard");
    expect(ulBootstrapRes.body.vpnConfig.excludedCIDRs).toBeInstanceOf(Array);

    // ── 8. Upload completion → VPS cleanup ──
    const freshUpload = await prisma.uploadJob.findUnique({
      where: { id: uploadJob!.id },
    });
    expect(freshUpload!.status).toBe("running");

    res = await request(app)
      .patch(`/uploads/${uploadJob!.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "completed" });
    expect(res.status).toBe(200);

    // ── 9. Verify VPS deleted + tokens cleaned ──
    expect(mockDeleteServer).toHaveBeenCalledWith(42);

    const remainingUploadTokens = await prisma.serviceToken.count({
      where: { jobId: uploadJob!.id },
    });
    expect(remainingUploadTokens).toBe(0);
  });
});
