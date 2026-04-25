import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import {
  generateServiceToken,
  storeServiceToken,
} from "../lib/service-token.js";

const app = createApp();

// Mock vps-config to avoid DB config dependencies
vi.mock("../lib/vps-config.js", () => ({
  getDownloadVpsConfig: vi.fn().mockResolvedValue({
    apiBaseUrl: "http://localhost:4000",
    s3AccessKey: "key",
    s3SecretKey: "secret",
    s3Endpoint: "https://s3.example.com",
    s3Bucket: "bucket",
    s3Region: "hel1",
    nzbServiceUrl: "http://nzb.example.com",
    dockerImage: "ghcr.io/test/downloader:latest",
    usenetServers: [{ host: "news.example.com", username: "user", password: "pass" }],
    routingPolicy: {
      mustVpn: [{ host: "news.example.com", port: 563 }],
      mustDirect: ["169.254.169.254/32", "10.0.0.0/8"],
    },
  }),
  getUploadVpsConfig: vi.fn().mockResolvedValue({
    apiBaseUrl: "http://localhost:4000",
    s3AccessKey: "key",
    s3SecretKey: "secret",
    s3Endpoint: "https://s3.example.com",
    s3Bucket: "bucket",
    nzbServiceUrl: "http://nzb.example.com",
    nzbServiceToken: "nzb-token",
    dockerImage: "ghcr.io/test/uploader:latest",
    usenetProviders: [{ host: "post.example.com", port: 563, username: "u", password: "p", ssl: true, connections: 20 }],
    routingPolicy: {
      mustVpn: [{ host: "post.example.com", port: 563 }],
      mustDirect: ["169.254.169.254/32", "10.0.0.0/8"],
    },
  }),
}));

describe("VPS Events + Routing Policy", () => {
  const originalStaticToken = process.env.SERVICE_API_TOKEN;

  afterEach(() => {
    if (originalStaticToken !== undefined) {
      process.env.SERVICE_API_TOKEN = originalStaticToken;
    } else {
      delete process.env.SERVICE_API_TOKEN;
    }
  });

  async function createTestDownloadJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Event Test", titleEn: "Event Test", year: 2026 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `evthash-${Date.now()}`, originalFilename: "event-test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id, status: "downloading" },
    });
    return { movie, nzbFile, job };
  }

  async function createTestUploadJob() {
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Upload Event", titleEn: "Upload Event", year: 2026 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `upevt-${Date.now()}`, originalFilename: "upload-event.nzb" },
    });
    const job = await prisma.uploadJob.create({
      data: { nzbFileId: nzbFile.id, status: "running" },
    });
    return { movie, nzbFile, job };
  }

  // ─── Bootstrap routingPolicy ─────────────────────────────────

  it("download bootstrap includes routingPolicy", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.routingPolicy).toBeDefined();
    expect(res.body.routingPolicy.mustVpn).toEqual([{ host: "news.example.com", port: 563 }]);
    expect(res.body.routingPolicy.mustDirect).toEqual(
      expect.arrayContaining(["169.254.169.254/32", "10.0.0.0/8"]),
    );
  });

  it("upload bootstrap includes routingPolicy", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestUploadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/bootstrap`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.routingPolicy).toBeDefined();
    expect(res.body.routingPolicy.mustVpn).toEqual([{ host: "post.example.com", port: 563 }]);
  });

  // ─── POST /service/jobs/:id/events ───────────────────────────

  it("creates a routing_anomaly event for download job", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .post(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({
        eventType: "routing_anomaly",
        severity: "critical",
        details: {
          connection: "news.example.com:563",
          expectedInterface: "wg0",
          actualInterface: "eth0",
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();

    // Verify in DB
    const event = await prisma.vpsEvent.findUnique({ where: { id: res.body.id } });
    expect(event).not.toBeNull();
    expect(event!.downloadJobId).toBe(job.id);
    expect(event!.jobType).toBe("download");
    expect(event!.eventType).toBe("routing_anomaly");
    expect(event!.severity).toBe("critical");
    expect((event!.details as Record<string, string>).expectedInterface).toBe("wg0");
  });

  it("creates a vpn_down event for upload job", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestUploadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "upload");

    const res = await request(app)
      .post(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({
        eventType: "vpn_down",
        severity: "critical",
        details: { interface: "wg0", reconnectAttempt: 3 },
      });

    expect(res.status).toBe(201);

    const event = await prisma.vpsEvent.findUnique({ where: { id: res.body.id } });
    expect(event!.jobType).toBe("upload");
    expect(event!.eventType).toBe("vpn_down");
  });

  it("defaults severity to warning", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .post(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ eventType: "watchdog", details: { status: "ok" } });

    expect(res.status).toBe(201);
    const event = await prisma.vpsEvent.findUnique({ where: { id: res.body.id } });
    expect(event!.severity).toBe("warning");
  });

  it("rejects invalid eventType", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .post(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ eventType: "invalid_type", details: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid eventType");
  });

  it("rejects invalid severity", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .post(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ eventType: "watchdog", severity: "banana", details: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid severity");
  });

  it("rejects event for nonexistent job", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const fakeJobId = "00000000-0000-0000-0000-000000000000";
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, fakeJobId, "download");

    const res = await request(app)
      .post(`/service/jobs/${fakeJobId}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ eventType: "watchdog", details: {} });

    expect(res.status).toBe(404);
  });

  it("rejects cross-job token access", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job: job1 } = await createTestDownloadJob();
    const { job: job2 } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job1.id, "download");

    const res = await request(app)
      .post(`/service/jobs/${job2.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`)
      .send({ eventType: "watchdog", details: {} });

    expect(res.status).toBe(401);
  });

  // ─── GET /service/jobs/:id/events ────────────────────────────

  it("returns events for a job", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    // Create some events
    await prisma.vpsEvent.createMany({
      data: [
        { downloadJobId: job.id, jobType: "download", eventType: "bootstrap", severity: "info", details: { phase: "started" } },
        { downloadJobId: job.id, jobType: "download", eventType: "watchdog", severity: "info", details: { vpn: "up" } },
        { downloadJobId: job.id, jobType: "download", eventType: "routing_anomaly", severity: "critical", details: { leak: true } },
      ],
    });

    const res = await request(app)
      .get(`/service/jobs/${job.id}/events`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    // All three event types present
    const types = res.body.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toContain("bootstrap");
    expect(types).toContain("watchdog");
    expect(types).toContain("routing_anomaly");
  });

  it("rejects negative limit", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    const res = await request(app)
      .get(`/service/jobs/${job.id}/events?limit=-1`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("limit must be greater than 0");
  });

  it("filters events by eventType", async () => {
    delete process.env.SERVICE_API_TOKEN;
    const { job } = await createTestDownloadJob();
    const { plaintext, hash } = generateServiceToken();
    await storeServiceToken(hash, job.id, "download");

    await prisma.vpsEvent.createMany({
      data: [
        { downloadJobId: job.id, jobType: "download", eventType: "bootstrap", severity: "info", details: {} },
        { downloadJobId: job.id, jobType: "download", eventType: "routing_anomaly", severity: "warning", details: {} },
        { downloadJobId: job.id, jobType: "download", eventType: "routing_anomaly", severity: "critical", details: {} },
      ],
    });

    const res = await request(app)
      .get(`/service/jobs/${job.id}/events?eventType=routing_anomaly`)
      .set("Authorization", `Bearer ${plaintext}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events.every((e: { eventType: string }) => e.eventType === "routing_anomaly")).toBe(true);
  });
});
