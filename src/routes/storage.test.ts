import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import jwt from "jsonwebtoken";

const app = createApp();

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-testing-only";

/** Create a test user and return a valid JWT token */
async function createTestUserAndToken(): Promise<{ token: string; userId: string }> {
  const user = await prisma.user.create({
    data: {
      email: `storage-test-${Date.now()}@test.de`,
      password: "$2b$10$dummyhash", // not used for auth in tests
      name: "Storage Test User",
    },
  });

  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });

  return { token, userId: user.id };
}

describe("Storage Routes", () => {
  describe("without auth", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/storage/files");
      expect(res.status).toBe(401);
    });
  });

  describe("with auth", () => {
    let token: string;

    beforeEach(async () => {
      const result = await createTestUserAndToken();
      token = result.token;
    });

    it("GET /storage/files returns file list", async () => {
      const res = await request(app)
        .get("/storage/files")
        .set("Authorization", `Bearer ${token}`);

      // If S3 is not configured in test env, expect 503
      if (res.status === 503) {
        expect(res.body.error).toContain("nicht konfiguriert");
        return;
      }

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("files");
      expect(Array.isArray(res.body.files)).toBe(true);
    });

    it("GET /storage/files supports prefix filter", async () => {
      const res = await request(app)
        .get("/storage/files?prefix=nonexistent-prefix/")
        .set("Authorization", `Bearer ${token}`);

      if (res.status === 503) return; // S3 not configured

      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
    });

    it("GET /storage/files/:key/url rejects invalid expires", async () => {
      const res = await request(app)
        .get("/storage/files/test-key.txt/url?expires=abc")
        .set("Authorization", `Bearer ${token}`);

      if (res.status === 503) return;

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("expires");
    });

    it("GET /storage/files/:key/meta returns 404 for missing file", async () => {
      const res = await request(app)
        .get("/storage/files/does-not-exist-12345.txt/meta")
        .set("Authorization", `Bearer ${token}`);

      if (res.status === 503) return;

      expect(res.status).toBe(404);
    });

    it("POST /storage/upload-url requires key", async () => {
      const res = await request(app)
        .post("/storage/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      if (res.status === 503) return;

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("key");
    });

    it("POST /storage/upload-url generates upload URL", async () => {
      const res = await request(app)
        .post("/storage/upload-url")
        .set("Authorization", `Bearer ${token}`)
        .send({ key: "test-upload/test.txt", contentType: "text/plain" });

      if (res.status === 503) return;

      expect(res.status).toBe(200);
      expect(res.body.url).toContain("openmedia-files");
      expect(res.body.key).toBe("test-upload/test.txt");
      expect(res.body.expiresIn).toBeDefined();
      expect(res.body.expiresAt).toBeDefined();
    });
  });
});
