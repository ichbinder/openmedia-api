import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";

const app = createApp();

async function createUserAndToken(email?: string) {
  const user = await prisma.user.create({
    data: {
      email: email || `lib-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
      password: "$2b$10$hash",
      name: "Lib Test",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

async function createTestNzbFile(s3Key?: string) {
  const movie = await prisma.nzbMovie.create({
    data: { titleDe: "Test Film", titleEn: "Test Movie", year: 2024 },
  });
  const nzbFile = await prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash: `libhash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalFilename: "test.nzb",
      s3Key: s3Key || null,
      s3Bucket: s3Key ? "openmedia-files" : null,
      fileExtension: s3Key ? ".mkv" : null,
      downloadedAt: s3Key ? new Date() : null,
    },
  });
  return { movie, nzbFile };
}

describe("Library Routes", () => {
  describe("GET /library", () => {
    it("gibt leere Bibliothek für neuen User", async () => {
      const { token } = await createUserAndToken();

      const res = await request(app)
        .get("/library")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it("zeigt nur eigene Bibliothek", async () => {
      const { user: user1, token: token1 } = await createUserAndToken();
      const { token: token2 } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("hash1/hash1.mkv");

      // User1 adds film
      await prisma.userLibrary.create({
        data: { userId: user1.id, nzbFileId: nzbFile.id },
      });

      // User2 should see empty library
      const res = await request(app)
        .get("/library")
        .set("Authorization", `Bearer ${token2}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);

      // User1 should see the film
      const res1 = await request(app)
        .get("/library")
        .set("Authorization", `Bearer ${token1}`);

      expect(res1.status).toBe(200);
      expect(res1.body.items).toHaveLength(1);
      expect(res1.body.items[0].nzbFile.movie.titleEn).toBe("Test Movie");
    });

    it("zeigt keine entfernten Filme", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("hash2/hash2.mkv");

      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: nzbFile.id, removedAt: new Date() },
      });

      const res = await request(app)
        .get("/library")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
    });

    it("lehnt unautorisiert ab", async () => {
      const res = await request(app).get("/library");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /library", () => {
    it("fügt Film zur Bibliothek hinzu", async () => {
      const { token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("hash3/hash3.mkv");

      const res = await request(app)
        .post("/library")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(200);
      expect(res.body.item.nzbFileId).toBe(nzbFile.id);
      expect(res.body.item.removedAt).toBeNull();
    });

    it("lehnt Film ohne s3Key ab", async () => {
      const { token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile(); // no s3Key

      const res = await request(app)
        .post("/library")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(422);
    });

    it("re-added einen entfernten Film", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("hash4/hash4.mkv");

      // Add then remove
      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: nzbFile.id, removedAt: new Date() },
      });

      // Re-add
      const res = await request(app)
        .post("/library")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(200);
      expect(res.body.item.removedAt).toBeNull();
    });

    it("lehnt fehlende nzbFileId ab", async () => {
      const { token } = await createUserAndToken();

      const res = await request(app)
        .post("/library")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /library/:nzbFileId", () => {
    it("entfernt Film aus Bibliothek (soft-delete)", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("hash5/hash5.mkv");

      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: nzbFile.id },
      });

      const res = await request(app)
        .delete(`/library/${nzbFile.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.removed).toBe(true);
    });

    it("löscht S3 wenn kein User den Film mehr braucht", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("todelete/todelete.mkv");

      await prisma.userLibrary.create({
        data: { userId: user.id, nzbFileId: nzbFile.id },
      });

      const res = await request(app)
        .delete(`/library/${nzbFile.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.s3Deleted).toBe(true);

      // s3Key should be null now
      const updated = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updated!.s3Key).toBeNull();
    });

    it("behält S3 wenn anderer User den Film noch hat", async () => {
      const { user: user1, token: token1 } = await createUserAndToken();
      const { user: user2 } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("keepme/keepme.mkv");

      // Both users have the film
      await prisma.userLibrary.create({ data: { userId: user1.id, nzbFileId: nzbFile.id } });
      await prisma.userLibrary.create({ data: { userId: user2.id, nzbFileId: nzbFile.id } });

      // User1 removes
      const res = await request(app)
        .delete(`/library/${nzbFile.id}`)
        .set("Authorization", `Bearer ${token1}`);

      expect(res.status).toBe(200);
      expect(res.body.s3Deleted).toBe(false);

      // S3 should still exist
      const updated = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updated!.s3Key).toBe("keepme/keepme.mkv");
    });

    it("gibt 404 für Film nicht in Bibliothek", async () => {
      const { token } = await createUserAndToken();

      const res = await request(app)
        .delete("/library/nonexistent-id")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /library/retention/:nzbFileId", () => {
    it("zeigt Anzahl aktiver User", async () => {
      const { user: user1, token } = await createUserAndToken();
      const { user: user2 } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("retain/retain.mkv");

      await prisma.userLibrary.create({ data: { userId: user1.id, nzbFileId: nzbFile.id } });
      await prisma.userLibrary.create({ data: { userId: user2.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/library/retention/${nzbFile.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.activeUsers).toBe(2);
      expect(res.body.inS3).toBe(true);
    });

    it("zählt entfernte User nicht mit", async () => {
      const { user: user1, token } = await createUserAndToken();
      const { user: user2 } = await createUserAndToken();
      const { nzbFile } = await createTestNzbFile("retain2/retain2.mkv");

      await prisma.userLibrary.create({ data: { userId: user1.id, nzbFileId: nzbFile.id } });
      await prisma.userLibrary.create({ data: { userId: user2.id, nzbFileId: nzbFile.id, removedAt: new Date() } });

      const res = await request(app)
        .get(`/library/retention/${nzbFile.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.activeUsers).toBe(1);
    });
  });
});
