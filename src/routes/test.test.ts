import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../app.js";
import testRoutes from "./test.js";
import { prisma } from "../test/setup.js";

/**
 * The production app only mounts /test routes when NODE_ENV === "test".
 * These tests run under vitest which sets NODE_ENV=test by default (see
 * vitest.config.ts), so createApp() mounts the router and the happy-path
 * tests work.
 *
 * The guard test temporarily flips NODE_ENV to "production" on a locally
 * assembled express app (NOT createApp, which would omit the router
 * entirely) to prove the in-router middleware rejects the request with 404.
 */

describe("POST /test/jobs/:id/force-complete — NODE_ENV guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns 404 when NODE_ENV is not 'test' even if the router is mounted", async () => {
    // Build a bare app with the test router forcibly mounted — this
    // simulates what would happen if someone bypassed the conditional
    // mount in app.ts. The in-router middleware must still reject.
    const app = express();
    app.use(express.json());
    app.use("/test", testRoutes);

    process.env.NODE_ENV = "production";

    const res = await request(app).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 404 when NODE_ENV is undefined", async () => {
    const app = express();
    app.use(express.json());
    app.use("/test", testRoutes);

    delete process.env.NODE_ENV;

    const res = await request(app).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
  });
});

describe("POST /test/jobs/:id/force-complete — happy path", () => {
  let userId: string;
  let nzbFileId: string;
  let movieId: string;
  let jobId: string;

  beforeEach(async () => {
    // Arrange a realistic scene: a user owns a queued download job that
    // references a NzbFile already linked to an NzbMovie (the post-assign
    // state the E2E flow reaches right before the download container would
    // normally take over).
    const user = await prisma.user.create({
      data: {
        email: "force-complete-test@example.com",
        password: "fake-hash",
        name: "Force Complete Tester",
      },
    });
    userId = user.id;

    const movie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 603,
        titleDe: "Matrix",
        titleEn: "The Matrix",
      },
    });
    movieId = movie.id;

    const nzbFile = await prisma.nzbFile.create({
      data: {
        hash: "force-complete-test-hash-0000000000000000",
        originalFilename: "The.Matrix.1999.1080p.nzb",
        status: "untested",
        movieId: movie.id,
      },
    });
    nzbFileId = nzbFile.id;

    const job = await prisma.downloadJob.create({
      data: {
        status: "queued",
        progress: 0,
        userId: user.id,
        nzbFileId: nzbFile.id,
      },
    });
    jobId = job.id;
  });

  it("marks the job completed, populates fake S3 keys, and upserts UserLibrary", async () => {
    const app = createApp();
    const res = await request(app).post(`/test/jobs/${jobId}/force-complete`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.s3Key).toMatch(/force-complete-test-hash/);
    expect(res.body.s3StreamKey).toMatch(/_stream\.mp4$/);

    const updatedJob = await prisma.downloadJob.findUnique({ where: { id: jobId } });
    expect(updatedJob?.status).toBe("completed");
    expect(updatedJob?.progress).toBe(100);
    expect(updatedJob?.completedAt).toBeInstanceOf(Date);

    const updatedFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });
    expect(updatedFile?.s3Key).toBe(
      "force-complete-test-hash-0000000000000000/force-complete-test-hash-0000000000000000.mkv",
    );
    expect(updatedFile?.s3StreamKey).toBe(
      "force-complete-test-hash-0000000000000000/force-complete-test-hash-0000000000000000_stream.mp4",
    );
    expect(updatedFile?.s3Bucket).toBe("e2e-fake-bucket");

    const libraryEntry = await prisma.userLibrary.findUnique({
      where: { userId_nzbFileId: { userId, nzbFileId } },
    });
    expect(libraryEntry).not.toBeNull();
    expect(libraryEntry?.removedAt).toBeNull();
  });

  it("is idempotent — calling twice leaves the same state", async () => {
    const app = createApp();
    const first = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(first.status).toBe(200);

    const second = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(second.status).toBe(200);

    const libraryEntries = await prisma.userLibrary.findMany({
      where: { userId, nzbFileId },
    });
    expect(libraryEntries).toHaveLength(1);
  });

  it("re-activates a previously removed library entry", async () => {
    // Pre-mark the library entry as removed — force-complete should
    // clear removedAt via the upsert update clause.
    await prisma.userLibrary.create({
      data: {
        userId,
        nzbFileId,
        removedAt: new Date(),
      },
    });

    const app = createApp();
    const res = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(res.status).toBe(200);

    const entry = await prisma.userLibrary.findUnique({
      where: { userId_nzbFileId: { userId, nzbFileId } },
    });
    expect(entry?.removedAt).toBeNull();
  });

  it("returns 404 for a non-existent job id", async () => {
    const app = createApp();
    const res = await request(app).post(
      "/test/jobs/00000000-0000-0000-0000-000000000000/force-complete",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Job not found");
  });

  it("returns 400 when the job has no userId", async () => {
    await prisma.downloadJob.update({
      where: { id: jobId },
      data: { userId: null },
    });

    const app = createApp();
    const res = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId/);

    // Suppress unused-variable warning for movieId (kept in scope for
    // potential future assertions about NzbMovie state).
    expect(movieId).toBeTruthy();
  });
});
