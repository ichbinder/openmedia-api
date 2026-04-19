import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import { randomBytes } from "node:crypto";

const app = createApp();
const TEST_MASTER_KEY = randomBytes(32).toString("hex");
const ADMIN_EMAIL = `admin-config-${Date.now()}@test.de`;
const SERVICE_TOKEN = "test-service-token-" + randomBytes(8).toString("hex");

async function createTestUserAndToken() {
  const user = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      password: "$2b$10$hash",
      name: "Admin Config Test",
    },
  });
  return { token: signToken({ userId: user.id, email: user.email }), userId: user.id };
}

async function seedCategories() {
  await prisma.configCategory.createMany({
    data: [
      { name: "s3", displayName: "S3 Storage" },
      { name: "nzb_service", displayName: "NZB Service" },
    ],
    skipDuplicates: true,
  });
}

async function seedProfile() {
  const s3 = await prisma.configCategory.findUnique({ where: { name: "s3" } });
  const nzb = await prisma.configCategory.findUnique({ where: { name: "nzb_service" } });

  const profile = await prisma.configProfile.create({
    data: { name: "download_vps", displayName: "Download VPS" },
  });

  if (s3) {
    await prisma.configProfileCategory.create({
      data: { profileId: profile.id, categoryId: s3.id },
    });
  }
  if (nzb) {
    await prisma.configProfileCategory.create({
      data: { profileId: profile.id, categoryId: nzb.id },
    });
  }
}

describe("Admin Config Routes", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  const originalServiceToken = process.env.SERVICE_API_TOKEN;

  beforeEach(async () => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
    process.env.ADMIN_EMAILS = ADMIN_EMAIL;
    process.env.SERVICE_API_TOKEN = SERVICE_TOKEN;
  });

  afterEach(async () => {
    // Clean up config tables and test users
    await prisma.configHistory.deleteMany();
    await prisma.configEntry.deleteMany();
    await prisma.configProfileCategory.deleteMany();
    await prisma.configProfile.deleteMany();
    await prisma.configCategory.deleteMany();
    await prisma.user.deleteMany({ where: { email: { contains: "config" } } });

    // Restore original env vars
    const restore = (key: string, original: string | undefined) => {
      if (original !== undefined) process.env[key] = original;
      else delete process.env[key];
    };
    restore("ENCRYPTION_MASTER_KEY", originalKey);
    restore("ADMIN_EMAILS", originalAdminEmails);
    restore("SERVICE_API_TOKEN", originalServiceToken);
  });

  describe("auth and authorization", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/admin/config/categories");
      expect(res.status).toBe(401);
    });

    it("rejects non-admin users", async () => {
      const nonAdmin = await prisma.user.create({
        data: {
          email: `nonadmin-${Date.now()}@test.de`,
          password: "$2b$10$hash",
          name: "Non-Admin",
        },
      });
      const token = signToken({ userId: nonAdmin.id, email: nonAdmin.email });

      const res = await request(app)
        .get("/admin/config/categories")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe("categories", () => {
    it("GET /admin/config/categories — lists categories", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      const res = await request(app)
        .get("/admin/config/categories")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.categories).toHaveLength(2);
      const names = res.body.categories.map((c: { name: string }) => c.name);
      expect(names).toContain("s3");
      expect(names).toContain("nzb_service");
    });

    it("POST /admin/config/categories — creates a category", async () => {
      const { token } = await createTestUserAndToken();

      const res = await request(app)
        .post("/admin/config/categories")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "test_cat", displayName: "Test Category" });

      expect(res.status).toBe(201);
      expect(res.body.category.name).toBe("test_cat");
    });
  });

  describe("entries", () => {
    it("PUT + GET — stores and retrieves plaintext entry", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      // Store
      const putRes = await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "endpoint", value: "https://fsn1.example.com" });

      expect(putRes.status).toBe(200);
      expect(putRes.body.entry.value).toBe("https://fsn1.example.com");

      // Retrieve
      const getRes = await request(app)
        .get("/admin/config/entries/s3/endpoint")
        .set("Authorization", `Bearer ${token}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.entry.value).toBe("https://fsn1.example.com");
    });

    it("PUT + GET — stores encrypted entry, masks by default", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "secret_key", value: "super-secret", encrypted: true });

      // Without reveal
      const masked = await request(app)
        .get("/admin/config/entries/s3/secret_key")
        .set("Authorization", `Bearer ${token}`);

      expect(masked.status).toBe(200);
      expect(masked.body.entry.value).toBe("••••••••");
      expect(masked.body.entry.encrypted).toBe(true);

      // With reveal
      const revealed = await request(app)
        .get("/admin/config/entries/s3/secret_key?reveal=true")
        .set("Authorization", `Bearer ${token}`);

      expect(revealed.status).toBe(200);
      expect(revealed.body.entry.value).toBe("super-secret");
    });

    it("PUT — upserts existing entry", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "bucket", value: "old-bucket" });

      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "bucket", value: "new-bucket" });

      const res = await request(app)
        .get("/admin/config/entries/s3/bucket")
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.entry.value).toBe("new-bucket");
    });

    it("DELETE — removes entry", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "temp", value: "delete-me" });

      const delRes = await request(app)
        .delete("/admin/config/entries/s3/temp")
        .set("Authorization", `Bearer ${token}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.deleted).toBe(true);

      const getRes = await request(app)
        .get("/admin/config/entries/s3/temp")
        .set("Authorization", `Bearer ${token}`);

      expect(getRes.status).toBe(404);
    });

    it("GET — returns 404 for unknown entry", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      const res = await request(app)
        .get("/admin/config/entries/s3/nonexistent")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("profiles + VPS endpoint", () => {
    it("GET /admin/config/profiles — lists profiles", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();
      await seedProfile();

      const res = await request(app)
        .get("/admin/config/profiles")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.profiles).toHaveLength(1);
      expect(res.body.profiles[0].name).toBe("download_vps");
      expect(res.body.profiles[0].categories).toHaveLength(2);
    });

    it("GET /admin/config/vps?type=download_vps — returns profile config via service token", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();
      await seedProfile();

      // Add some entries (via admin)
      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "endpoint", value: "https://fsn1.example.com" });

      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "access_key", value: "AKID123", encrypted: true });

      // Fetch via service token (as VPS would)
      const res = await request(app)
        .get("/admin/config/vps?type=download_vps")
        .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.profile).toBe("download_vps");
      expect(res.body.config.s3.endpoint).toBe("https://fsn1.example.com");
      expect(res.body.config.s3.access_key).toBe("AKID123");
    });

    it("GET /admin/config/vps — returns 400 without type", async () => {
      const res = await request(app)
        .get("/admin/config/vps")
        .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

      expect(res.status).toBe(400);
    });

    it("GET /admin/config/vps — rejects invalid service token", async () => {
      const res = await request(app)
        .get("/admin/config/vps?type=download_vps")
        .set("Authorization", "Bearer wrong-token");

      expect(res.status).toBe(401);
    });
  });

  describe("history", () => {
    it("tracks create and update actions", async () => {
      const { token } = await createTestUserAndToken();
      await seedCategories();

      // Create
      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "bucket", value: "v1" });

      // Update
      await request(app)
        .put("/admin/config/entries")
        .set("Authorization", `Bearer ${token}`)
        .send({ categoryName: "s3", key: "bucket", value: "v2" });

      const res = await request(app)
        .get("/admin/config/history/s3/bucket")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(2);
      expect(res.body.history[0].action).toBe("updated");
      expect(res.body.history[1].action).toBe("created");
    });
  });
});
