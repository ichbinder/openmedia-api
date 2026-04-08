import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../app.js";
import testRoutes from "./test.js";
import { prisma } from "../test/setup.js";

/**
 * The production app only mounts /test routes when NODE_ENV === "test".
 * The router middleware additionally requires ENABLE_TEST_ENDPOINTS="1".
 *
 * These tests run under vitest which sets NODE_ENV=test by default. Happy
 * path tests set ENABLE_TEST_ENDPOINTS explicitly. Guard tests build a bare
 * express app with the router forcibly mounted and flip env vars to prove
 * each independent check rejects requests on its own.
 */

describe("POST /test/jobs/:id/force-complete — env var guards", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableFlag = process.env.ENABLE_TEST_ENDPOINTS;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalEnableFlag === undefined) {
      delete process.env.ENABLE_TEST_ENDPOINTS;
    } else {
      process.env.ENABLE_TEST_ENDPOINTS = originalEnableFlag;
    }
  });

  function buildBareApp() {
    const app = express();
    app.use(express.json());
    app.use("/test", testRoutes);
    return app;
  }

  it("returns 404 when NODE_ENV is not 'test' even if ENABLE_TEST_ENDPOINTS=1", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENABLE_TEST_ENDPOINTS = "1";

    const res = await request(buildBareApp()).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 404 when NODE_ENV is undefined", async () => {
    delete process.env.NODE_ENV;
    process.env.ENABLE_TEST_ENDPOINTS = "1";

    const res = await request(buildBareApp()).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
  });

  it("returns 404 when ENABLE_TEST_ENDPOINTS is unset even if NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.ENABLE_TEST_ENDPOINTS;

    const res = await request(buildBareApp()).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 404 when ENABLE_TEST_ENDPOINTS is any value other than '1'", async () => {
    process.env.NODE_ENV = "test";
    process.env.ENABLE_TEST_ENDPOINTS = "true";

    const res = await request(buildBareApp()).post("/test/jobs/any-id/force-complete");
    expect(res.status).toBe(404);
  });
});

describe("POST /test/jobs/:id/force-complete — happy path", () => {
  let userId: string;
  let nzbFileId: string;
  let movieId: string;
  let jobId: string;

  const originalEnableFlag = process.env.ENABLE_TEST_ENDPOINTS;

  afterEach(() => {
    if (originalEnableFlag === undefined) {
      delete process.env.ENABLE_TEST_ENDPOINTS;
    } else {
      process.env.ENABLE_TEST_ENDPOINTS = originalEnableFlag;
    }
  });

  beforeEach(async () => {
    // Turn on the test endpoint opt-in flag for every happy-path case.
    process.env.ENABLE_TEST_ENDPOINTS = "1";

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
    // Must start with a dot to match the production schema contract.
    expect(updatedFile?.fileExtension).toBe(".mkv");

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

  it("re-activates a previously removed library entry and bumps addedAt", async () => {
    // Pre-mark the library entry as removed with a stale addedAt — the
    // upsert's update branch must clear removedAt AND refresh addedAt so
    // the film jumps to the top of the user's library list on re-add.
    const staleTimestamp = new Date("2020-01-01T00:00:00Z");
    await prisma.userLibrary.create({
      data: {
        userId,
        nzbFileId,
        addedAt: staleTimestamp,
        removedAt: staleTimestamp,
      },
    });

    const app = createApp();
    const res = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(res.status).toBe(200);

    const entry = await prisma.userLibrary.findUnique({
      where: { userId_nzbFileId: { userId, nzbFileId } },
    });
    expect(entry?.removedAt).toBeNull();
    // addedAt must be refreshed, not the stale 2020 value.
    expect(entry?.addedAt.getTime()).toBeGreaterThan(staleTimestamp.getTime());
  });

  it("handles jobs in any starting status (needs_review, queued, etc.)", async () => {
    // The force-complete handler reads the current status and uses it as
    // the CAS precondition. As long as nothing changes the status
    // between the read and the transactional write, the update succeeds
    // regardless of the starting status. This test runs the happy path
    // with status='needs_review' (the actual starting point for the
    // single-user M021 flow after upload but before manual assign).
    await prisma.downloadJob.update({
      where: { id: jobId },
      data: { status: "needs_review" },
    });

    const app = createApp();
    const res = await request(app).post(`/test/jobs/${jobId}/force-complete`);
    expect(res.status).toBe(200);

    const updated = await prisma.downloadJob.findUnique({ where: { id: jobId } });
    expect(updated?.status).toBe("completed");
    expect(updated?.progress).toBe(100);
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
