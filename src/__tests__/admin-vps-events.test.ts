import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import { randomBytes } from "node:crypto";

const app = createApp();
const ADMIN_EMAIL = `admin-vps-events-${Date.now()}@test.de`;

async function createAdminToken() {
  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      password: "$2b$10$hash",
      name: "VPS Events Admin",
    },
  });
  return { token: signToken({ userId: user.id, email: user.email }), userId: user.id };
}

describe("Admin VPS Events", () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  let token: string;

  beforeEach(async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    const result = await createAdminToken();
    token = result.token;
  });

  afterEach(async () => {
    await prisma.vpsEvent.deleteMany();
    await prisma.downloadJob.deleteMany();
    await prisma.uploadJob.deleteMany();
    await prisma.user.deleteMany({ where: { email: { contains: "vps-events" } } });

    if (originalAdminEmails !== undefined) process.env.ADMIN_EMAILS = originalAdminEmails;
    else delete process.env.ADMIN_EMAILS;
  });

  it("returns empty list when no events exist", async () => {
    const res = await request(app)
      .get("/admin/config/vps-events")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("returns events ordered by createdAt desc", async () => {
    await prisma.vpsEvent.createMany({
      data: [
        { jobType: "download", eventType: "bootstrap", severity: "info", details: { phase: "start" } },
        { jobType: "download", eventType: "routing_anomaly", severity: "warning", details: { host: "news.eweka.nl" } },
        { jobType: "upload", eventType: "vpn_down", severity: "critical", details: { iface: "wg0" } },
      ],
    });

    const res = await request(app)
      .get("/admin/config/vps-events")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    expect(res.body.total).toBe(3);
    // Most recent first
    const timestamps = res.body.events.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
    expect(timestamps[1]).toBeGreaterThanOrEqual(timestamps[2]);
  });

  it("filters by jobType", async () => {
    await prisma.vpsEvent.createMany({
      data: [
        { jobType: "download", eventType: "bootstrap", severity: "info", details: {} },
        { jobType: "upload", eventType: "bootstrap", severity: "info", details: {} },
      ],
    });

    const res = await request(app)
      .get("/admin/config/vps-events?jobType=upload")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].jobType).toBe("upload");
    expect(res.body.total).toBe(1);
  });

  it("filters by eventType", async () => {
    await prisma.vpsEvent.createMany({
      data: [
        { jobType: "download", eventType: "routing_anomaly", severity: "warning", details: {} },
        { jobType: "download", eventType: "bootstrap", severity: "info", details: {} },
      ],
    });

    const res = await request(app)
      .get("/admin/config/vps-events?eventType=routing_anomaly")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].eventType).toBe("routing_anomaly");
  });

  it("filters by severity", async () => {
    await prisma.vpsEvent.createMany({
      data: [
        { jobType: "download", eventType: "vpn_down", severity: "critical", details: {} },
        { jobType: "download", eventType: "bootstrap", severity: "info", details: {} },
      ],
    });

    const res = await request(app)
      .get("/admin/config/vps-events?severity=critical")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].severity).toBe("critical");
  });

  it("supports pagination with limit and offset", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      jobType: "download" as const,
      eventType: "bootstrap",
      severity: "info",
      details: { index: i },
    }));
    await prisma.vpsEvent.createMany({ data: events });

    const res = await request(app)
      .get("/admin/config/vps-events?limit=2&offset=1")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });

  it("rejects non-admin users", async () => {
    // Create a non-admin user
    const user = await prisma.user.create({
      data: {
        email: `nonadmin-vps-events-${Date.now()}@test.de`,
        password: "$2b$10$hash",
        name: "Non Admin",
      },
    });
    const nonAdminToken = signToken({ userId: user.id, email: user.email });

    const res = await request(app)
      .get("/admin/config/vps-events")
      .set("Authorization", `Bearer ${nonAdminToken}`);

    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/admin/config/vps-events");
    expect(res.status).toBe(401);
  });
});
