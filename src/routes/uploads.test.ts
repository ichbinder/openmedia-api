import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

const app = createApp();

// Helper: register a test user and get auth token
let emailCounter = 200;
async function getAuthToken() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `upload-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "Upload User" });
  return res.body.token as string;
}

async function createTestNzbFile(s3Key?: string) {
  const movie = await prisma.nzbMovie.create({
    data: { titleDe: "Testfilm", titleEn: "Test Movie", year: 2024, tmdbId: 88800 + emailCounter },
  });
  return prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash: `test-hash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      originalFilename: "Test.Movie.2024.1080p.BluRay.x264.mkv",
      resolution: "1080p",
      s3Key: s3Key || `test-hash-${Date.now()}/original.mkv`,
    },
  });
}

describe("UploadJob routes", () => {
  let authToken: string;

  beforeAll(async () => {
    authToken = await getAuthToken();
  });

  beforeEach(async () => {
    await prisma.uploadJob.deleteMany();
    await prisma.nzbFile.deleteMany();
    await prisma.nzbMovie.deleteMany();
  });

  describe("POST /uploads", () => {
    it("creates an upload job for a valid NzbFile", async () => {
      const nzbFile = await createTestNzbFile();

      const res = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("queued");
      expect(res.body.nzbFileId).toBe(nzbFile.id);
      expect(res.body.id).toBeDefined();
    });

    it("rejects when NzbFile already has ownUsenetHash", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "Schon hochgeladen", titleEn: "Already Uploaded", year: 2024, tmdbId: 88900 },
      });
      const nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash: `existing-hash-${Date.now()}`,
          originalFilename: "existing.mkv",
          s3Key: "existing-hash/original.mkv",
          ownUsenetHash: "already-uploaded-hash",
        },
      });

      const res = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already has an own Usenet upload");
    });

    it("rejects when NzbFile has no s3Key", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "No S3", titleEn: "No S3", year: 2024, tmdbId: 88901 },
      });
      const nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash: `no-s3-hash-${Date.now()}`,
          originalFilename: "no-s3.mkv",
          // no s3Key
        },
      });

      const res = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("no s3Key");
    });

    it("rejects duplicate when job already running", async () => {
      const nzbFile = await createTestNzbFile();

      const res1 = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ nzbFileId: nzbFile.id });
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res2.status).toBe(409);
      expect(res2.body.error).toContain("already in progress");
    });

    it("requires nzbFileId", async () => {
      const res = await request(app)
        .post("/uploads")
        .set("Authorization", `Bearer ${authToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("nzbFileId is required");
    });
  });

  describe("PATCH /uploads/:id", () => {
    it("transitions from queued to running", async () => {
      const nzbFile = await createTestNzbFile();
      const job = await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id } });

      const res = await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "running", hetznerServerId: 12345 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("running");
    });

    it("sets ownUsenetHash on NzbFile when completed", async () => {
      const nzbFile = await createTestNzbFile();
      const job = await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id } });

      // queued → running → completed
      await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "running" });

      const res = await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "completed", nzbS3Key: "nzb/test-hash.nzb" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");

      // Verify NzbFile was updated
      const updated = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updated?.ownUsenetHash).not.toBeNull();
      expect(updated?.ownNzbS3Key).toBe("nzb/test-hash.nzb");
      expect(updated?.ownUsenetUploadedAt).not.toBeNull();
    });

    it("rejects invalid status transitions", async () => {
      const nzbFile = await createTestNzbFile();
      const job = await prisma.uploadJob.create({
        data: { nzbFileId: nzbFile.id, status: "completed" },
      });

      const res = await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "queued" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Invalid status transition");
    });

    it("sets completedAt on completion", async () => {
      const nzbFile = await createTestNzbFile();
      const job = await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id } });

      await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "running" });

      const res = await request(app)
        .patch(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "completed", nzbS3Key: "nzb/test.nzb" });

      expect(res.body.completedAt).toBeDefined();
    });

    it("returns 404 for non-existent job", async () => {
      const res = await request(app)
        .patch("/uploads/nonexistent-id")
        .set("Authorization", `Bearer ${authToken}`)
        .send({ status: "running" });

      expect(res.status).toBe(404);
    });
  });

  describe("GET /uploads", () => {
    it("lists upload jobs", async () => {
      const nzbFile = await createTestNzbFile();
      await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get("/uploads")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const nzbFile = await createTestNzbFile();
      await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id, status: "running" } });

      const res = await request(app)
        .get("/uploads?status=running")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.every((j: { status: string }) => j.status === "running")).toBe(true);
    });
  });

  describe("GET /uploads/:id", () => {
    it("returns a single upload job", async () => {
      const nzbFile = await createTestNzbFile();
      const job = await prisma.uploadJob.create({ data: { nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/uploads/${job.id}`)
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(job.id);
      expect(res.body.nzbFile.hash).toBeDefined();
    });

    it("returns 404 for non-existent job", async () => {
      const res = await request(app)
        .get("/uploads/nonexistent-id")
        .set("Authorization", `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });
});
