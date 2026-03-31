import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import { randomBytes } from "node:crypto";

const app = createApp();
const TEST_MASTER_KEY = randomBytes(32).toString("hex");

async function createTestUserAndToken() {
  const user = await prisma.user.create({
    data: { email: `config-test-${Date.now()}@test.de`, password: "$2b$10$hash", name: "Config Test" },
  });
  return signToken({ userId: user.id, email: user.email });
}

describe("Config Routes", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  afterEach(() => {
    if (originalKey) {
      process.env.ENCRYPTION_MASTER_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_MASTER_KEY;
    }
  });

  describe("without encryption configured", () => {
    it("returns 503 when ENCRYPTION_MASTER_KEY is missing", async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      const token = await createTestUserAndToken();

      const res = await request(app)
        .get("/config/keys")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("nicht konfiguriert");
    });
  });

  describe("without auth", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/config/keys");
      expect(res.status).toBe(401);
    });
  });

  describe("CRUD operations", () => {
    let token: string;

    beforeEach(async () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
      token = await createTestUserAndToken();
    });

    it("PUT /config/:key — stores encrypted config", async () => {
      const res = await request(app)
        .put("/config/usenet-password")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "my-secret-password" });

      expect(res.status).toBe(200);
      expect(res.body.key).toBe("usenet-password");
      expect(res.body.saved).toBe(true);

      // Verify it's encrypted in DB (not plaintext)
      const dbRecord = await prisma.encryptedConfig.findUnique({ where: { key: "usenet-password" } });
      expect(dbRecord).toBeDefined();
      expect(dbRecord!.encryptedValue).not.toBe("my-secret-password");
      expect(dbRecord!.iv).toHaveLength(32);
      expect(dbRecord!.tag).toHaveLength(32);
    });

    it("GET /config/:key — reads decrypted config", async () => {
      // First store
      await request(app)
        .put("/config/test-key")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "test-value-123" });

      // Then read
      const res = await request(app)
        .get("/config/test-key")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.key).toBe("test-key");
      expect(res.body.value).toBe("test-value-123");
    });

    it("GET /config/:key — returns 404 for unknown key", async () => {
      const res = await request(app)
        .get("/config/nonexistent")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("PUT /config/:key — upserts existing key", async () => {
      await request(app)
        .put("/config/update-me")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "original" });

      await request(app)
        .put("/config/update-me")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "updated" });

      const res = await request(app)
        .get("/config/update-me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.value).toBe("updated");
    });

    it("PUT /config/:key — rejects missing value", async () => {
      const res = await request(app)
        .put("/config/bad")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("value");
    });

    it("DELETE /config/:key — deletes config", async () => {
      await request(app)
        .put("/config/delete-me")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "doomed" });

      const res = await request(app)
        .delete("/config/delete-me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await request(app)
        .get("/config/delete-me")
        .set("Authorization", `Bearer ${token}`);

      expect(getRes.status).toBe(404);
    });

    it("DELETE /config/:key — returns 404 for unknown key", async () => {
      const res = await request(app)
        .delete("/config/nonexistent")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("GET /config/keys — lists all keys without values", async () => {
      await request(app)
        .put("/config/s3-access-key")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "secret1" });

      await request(app)
        .put("/config/usenet-host")
        .set("Authorization", `Bearer ${token}`)
        .send({ value: "secret2" });

      const res = await request(app)
        .get("/config/keys")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.keys).toContain("s3-access-key");
      expect(res.body.keys).toContain("usenet-host");
      // Values should NOT be in the response
      expect(JSON.stringify(res.body)).not.toContain("secret1");
      expect(JSON.stringify(res.body)).not.toContain("secret2");
    });
  });
});
