import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";

const app = createApp();
const ADMIN_EMAIL = `admin-incidents-${Date.now()}@test.de`;

async function createAdminToken() {
  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      password: "$2b$10$hash",
      name: "Incidents Admin",
    },
  });
  return { token: signToken({ userId: user.id, email: user.email }), userId: user.id };
}

describe("GET /admin/config/incidents", () => {
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  let token: string;
  // Track only users created by this test run so afterEach doesn't accidentally
  // delete unrelated users that happen to match a "incidents" substring.
  const createdUserIds: string[] = [];

  beforeEach(async () => {
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    await prisma.serviceIncident.deleteMany();
    const result = await createAdminToken();
    createdUserIds.push(result.userId);
    token = result.token;
  });

  afterEach(async () => {
    await prisma.serviceIncident.deleteMany();
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }

    if (originalAdminEmails !== undefined) process.env.ADMIN_EMAILS = originalAdminEmails;
    else delete process.env.ADMIN_EMAILS;
  });

  it("returns empty list when no incidents exist", async () => {
    const res = await request(app)
      .get("/admin/config/incidents")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.incidents).toEqual([]);
  });

  it("returns only open incidents, ordered by lastSeenAt desc", async () => {
    const now = Date.now();
    await prisma.serviceIncident.createMany({
      data: [
        {
          service: "nzb-service",
          operation: "store",
          status: "open",
          message: "older open",
          lastSeenAt: new Date(now - 60_000),
          occurrences: 2,
        },
        {
          service: "nzb-service",
          operation: "fetch",
          status: "open",
          message: "newer open",
          lastSeenAt: new Date(now),
          occurrences: 5,
        },
        {
          service: "nzb-service",
          operation: "store",
          status: "resolved",
          message: "resolved one",
          lastSeenAt: new Date(now + 60_000),
          resolvedAt: new Date(now + 60_000),
          occurrences: 1,
        },
      ],
    });

    const res = await request(app)
      .get("/admin/config/incidents")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(2);
    expect(res.body.incidents[0].message).toBe("newer open");
    expect(res.body.incidents[1].message).toBe("older open");
    expect(res.body.incidents[0]).toMatchObject({
      service: "nzb-service",
      operation: "fetch",
      occurrences: 5,
    });
    expect(res.body.incidents[0]).toHaveProperty("id");
    expect(res.body.incidents[0]).toHaveProperty("firstSeenAt");
    expect(res.body.incidents[0]).toHaveProperty("lastSeenAt");
    // Resolved incident must not leak through
    for (const inc of res.body.incidents) {
      expect(inc.message).not.toBe("resolved one");
      // Sicherstellen dass keine sensiblen Felder geleakt werden
      expect(inc).not.toHaveProperty("status");
      expect(inc).not.toHaveProperty("resolvedAt");
    }
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/admin/config/incidents");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin users with 403", async () => {
    const user = await prisma.user.create({
      data: {
        email: `nonadmin-incidents-${Date.now()}@test.de`,
        password: "$2b$10$hash",
        name: "Non Admin",
      },
    });
    createdUserIds.push(user.id);
    const nonAdminToken = signToken({ userId: user.id, email: user.email });

    const res = await request(app)
      .get("/admin/config/incidents")
      .set("Authorization", `Bearer ${nonAdminToken}`);

    expect(res.status).toBe(403);
  });
});
