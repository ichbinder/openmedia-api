/**
 * Integration tests for the needs_review reconciler paths (M021/S02).
 *
 * Unlike job-reconciler.test.ts (which mocks Prisma), these tests use the
 * real test database because the retry + cleanup paths involve multi-row
 * transactions and side effects that are painful to mock accurately.
 *
 * TMDB, the provisioner, the nzb-service client, and Hetzner are mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../test/setup.js";

// Mock TMDB
vi.mock("./tmdb.js", () => ({
  searchTmdbMovie: vi.fn(),
  searchTmdbMovieById: vi.fn(),
}));

// Mock provisioner — we don't want to hit real Hetzner
vi.mock("./provisioner.js", () => ({
  provisionDownload: vi.fn().mockResolvedValue(undefined),
}));

// Mock the NZB-service client
vi.mock("./nzb-service.js", () => ({
  storeNzbInService: vi.fn().mockResolvedValue(true),
  deleteNzbFromService: vi.fn().mockResolvedValue(true),
}));

// Mock Hetzner for the stale-check path (not the focus of these tests)
vi.mock("./hetzner.js", () => ({
  isHetznerConfigured: vi.fn(() => false),
  getServer: vi.fn(),
  deleteServer: vi.fn(),
  listServers: vi.fn(() => []),
}));

import { searchTmdbMovie } from "./tmdb.js";
import { provisionDownload } from "./provisioner.js";
import { deleteNzbFromService } from "./nzb-service.js";
import {
  retryTmdbForPendingReviews,
  cleanupExpiredReviews,
  reconcileStaleJobs,
  type ReconcileResult,
} from "./job-reconciler.js";

const mockSearchTmdbMovie = vi.mocked(searchTmdbMovie);
const mockProvisionDownload = vi.mocked(provisionDownload);
const mockDeleteNzbFromService = vi.mocked(deleteNzbFromService);

function emptyResult(): ReconcileResult {
  return {
    checked: 0,
    failed: 0,
    zombiesDeleted: 0,
    tmdbRetried: 0,
    tmdbAutoAssigned: 0,
    expired: 0,
    orphansDeleted: 0,
    details: [],
  };
}

let userCounter = 0;
async function createUser() {
  userCounter++;
  return prisma.user.create({
    data: {
      email: `reconciler-review-${userCounter}-${Date.now()}@test.de`,
      password: "hashed",
      name: "Reconciler Test User",
    },
  });
}

/** Create a needs_review NzbFile + DownloadJob in the DB for a given user. */
async function createNeedsReviewJob(opts: {
  userId: string | null;
  hash: string;
  originalFilename?: string;
  reviewExpiresAt?: Date | null;
  tmdbRetryAfter?: Date | null;
  tmdbRetryCount?: number;
  sharedNzbFileId?: string; // reuse an existing NzbFile instead of creating one
}): Promise<{ jobId: string; nzbFileId: string }> {
  let nzbFileId = opts.sharedNzbFileId;

  if (!nzbFileId) {
    const nzbFile = await prisma.nzbFile.create({
      data: {
        hash: opts.hash,
        originalFilename: opts.originalFilename ?? `${opts.hash.slice(0, 8)}.nzb`,
        movieId: null, // needs_review
      },
    });
    nzbFileId = nzbFile.id;
  }

  const job = await prisma.downloadJob.create({
    data: {
      nzbFileId,
      userId: opts.userId,
      status: "needs_review",
      reviewExpiresAt: opts.reviewExpiresAt ?? null,
      tmdbRetryAfter: opts.tmdbRetryAfter ?? null,
      tmdbRetryCount: opts.tmdbRetryCount ?? 0,
    },
  });

  return { jobId: job.id, nzbFileId };
}

describe("retryTmdbForPendingReviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvisionDownload.mockResolvedValue(undefined);
  });

  it("auto-assigns a NzbFile when TMDB retry succeeds", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);

    const { jobId, nzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "retry-success-" + Date.now(),
      originalFilename: "Matrix.1999.1080p.BluRay.x264.nzb",
      tmdbRetryAfter: past,
    });

    mockSearchTmdbMovie.mockResolvedValueOnce({
      status: "found",
      movie: {
        tmdbId: 603,
        imdbId: "tt0133093",
        titleDe: "Matrix",
        titleEn: "The Matrix",
        description: "...",
        year: 1999,
        posterPath: "/matrix.jpg",
      },
    });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result);

    expect(result.tmdbRetried).toBe(1);
    expect(result.tmdbAutoAssigned).toBe(1);

    // Job flipped to queued
    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("queued");
    expect(job.tmdbRetryAfter).toBeNull();

    // NzbFile linked to new movie
    const nzbFile = await prisma.nzbFile.findUniqueOrThrow({
      where: { id: nzbFileId },
      include: { movie: true },
    });
    expect(nzbFile.movieId).not.toBeNull();
    expect(nzbFile.movie?.tmdbId).toBe(603);
    expect(nzbFile.movie?.titleEn).toBe("The Matrix");

    // Provisioner triggered
    expect(mockProvisionDownload).toHaveBeenCalledWith(jobId);
  });

  it("bumps retry count and schedules next attempt at exactly 60s on first not_found", async () => {
    const user = await createUser();
    // Fixed `now` so we can assert the scheduled delay exactly — catches any
    // regression of the backoff off-by-one CodeRabbit + Greptile flagged.
    const now = new Date("2026-06-01T12:00:00.000Z");
    const past = new Date(now.getTime() - 1000);

    const { jobId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "retry-notfound-" + Date.now(),
      originalFilename: "Xyzzy.2099.nzb",
      tmdbRetryAfter: past,
      tmdbRetryCount: 0,
    });

    mockSearchTmdbMovie.mockResolvedValueOnce({ status: "not_found" });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result, now);

    expect(result.tmdbRetried).toBe(1);
    expect(result.tmdbAutoAssigned).toBe(0);

    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("needs_review");
    expect(job.tmdbRetryCount).toBe(1);
    // First retry must land exactly 60 seconds in the future (BACKOFF[0]),
    // NOT 5 minutes (BACKOFF[1]). Strict equality guards the off-by-one.
    expect(job.tmdbRetryAfter?.toISOString()).toBe(
      new Date(now.getTime() + 60_000).toISOString()
    );
  });

  it("applies the full backoff schedule across retry counts 1-4", async () => {
    // Sweep the schedule: (countBefore, expectedDelayMs)
    const cases: Array<[number, number]> = [
      [0, 60 * 1000],         // 1st failure → BACKOFF[0] = 60s
      [1, 5 * 60 * 1000],     // 2nd failure → BACKOFF[1] = 5min
      [2, 30 * 60 * 1000],    // 3rd failure → BACKOFF[2] = 30min
      [3, 2 * 60 * 60 * 1000], // 4th failure → BACKOFF[3] = 2h
    ];

    for (const [countBefore, expectedDelayMs] of cases) {
      const user = await createUser();
      const now = new Date("2026-06-01T12:00:00.000Z");
      const past = new Date(now.getTime() - 1000);

      const { jobId } = await createNeedsReviewJob({
        userId: user.id,
        hash: `retry-sweep-${countBefore}-` + Date.now(),
        originalFilename: "Sweep.nzb",
        tmdbRetryAfter: past,
        tmdbRetryCount: countBefore,
      });

      mockSearchTmdbMovie.mockResolvedValueOnce({ status: "not_found" });

      const result = emptyResult();
      await retryTmdbForPendingReviews(result, now);

      const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.tmdbRetryCount).toBe(countBefore + 1);
      expect(job.tmdbRetryAfter?.toISOString()).toBe(
        new Date(now.getTime() + expectedDelayMs).toISOString()
      );
    }
  });

  it("gives up after MAX_TMDB_RETRIES reached", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);

    // tmdbRetryCount=4, one more failure should set count=5 and tmdbRetryAfter=null
    const { jobId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "retry-max-" + Date.now(),
      originalFilename: "Max.Retries.nzb",
      tmdbRetryAfter: past,
      tmdbRetryCount: 4,
    });

    mockSearchTmdbMovie.mockResolvedValueOnce({ status: "not_found" });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result);

    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("needs_review");
    expect(job.tmdbRetryCount).toBe(5);
    expect(job.tmdbRetryAfter).toBeNull(); // no more auto-retries
  });

  it("ignores jobs whose tmdbRetryAfter is still in the future", async () => {
    const user = await createUser();
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h

    const { jobId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "retry-future-" + Date.now(),
      originalFilename: "Future.nzb",
      tmdbRetryAfter: future,
    });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result);

    expect(result.tmdbRetried).toBe(0);
    expect(mockSearchTmdbMovie).not.toHaveBeenCalled();

    // Job untouched
    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("needs_review");
    expect(job.tmdbRetryCount).toBe(0);
  });

  it("dedupes: single TMDB call for multiple jobs on the same NzbFile", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const past = new Date(Date.now() - 1000);
    const hash = "retry-shared-" + Date.now();

    const { jobId: jobAId, nzbFileId } = await createNeedsReviewJob({
      userId: userA.id,
      hash,
      originalFilename: "Shared.1080p.nzb",
      tmdbRetryAfter: past,
    });
    const { jobId: jobBId } = await createNeedsReviewJob({
      userId: userB.id,
      hash: "unused", // overridden by sharedNzbFileId
      tmdbRetryAfter: past,
      sharedNzbFileId: nzbFileId,
    });

    mockSearchTmdbMovie.mockResolvedValueOnce({
      status: "found",
      movie: {
        tmdbId: 550,
        imdbId: "tt0137523",
        titleDe: "Fight Club",
        titleEn: "Fight Club",
        description: "...",
        year: 1999,
        posterPath: "/fightclub.jpg",
      },
    });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result);

    // TMDB called exactly once despite 2 jobs
    expect(mockSearchTmdbMovie).toHaveBeenCalledTimes(1);

    // Both jobs flipped
    const jobA = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobAId } });
    const jobB = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobBId } });
    expect(jobA.status).toBe("queued");
    expect(jobB.status).toBe("queued");

    // Provisioner triggered for both
    expect(mockProvisionDownload).toHaveBeenCalledTimes(2);
  });

  it("flips sibling jobs if NzbFile was already assigned between query and retry", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);

    const { jobId, nzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "retry-raced-" + Date.now(),
      originalFilename: "Raced.nzb",
      tmdbRetryAfter: past,
    });

    // Simulate another path (manual assign, concurrent retry) setting movieId
    // between the initial SELECT and our iteration.
    const otherMovie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 777_777,
        titleDe: "Other",
        titleEn: "Other",
        year: 2020,
      },
    });
    await prisma.nzbFile.update({
      where: { id: nzbFileId },
      data: { movieId: otherMovie.id },
    });

    const result = emptyResult();
    await retryTmdbForPendingReviews(result);

    // TMDB NOT called (we detected the race early)
    expect(mockSearchTmdbMovie).not.toHaveBeenCalled();

    // Job flipped to queued (sibling catch-up)
    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("queued");
    expect(mockProvisionDownload).toHaveBeenCalledWith(jobId);
  });
});

describe("cleanupExpiredReviews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteNzbFromService.mockResolvedValue(true);
  });

  it("expires a single-job NzbFile and deletes the orphan (+ cascades the job)", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);
    const hash = "cleanup-single-" + Date.now();

    const { jobId, nzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash,
      reviewExpiresAt: past,
    });

    const result = emptyResult();
    await cleanupExpiredReviews(result);

    expect(result.expired).toBe(1);
    expect(result.orphansDeleted).toBe(1);

    // NzbFile is gone, and due to `onDelete: Cascade` on DownloadJob.nzbFile,
    // the job row itself was cascaded away at the same time. That's the
    // intended behaviour — once the NzbFile is deleted, dangling expired
    // job rows would just be clutter.
    const nzbFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });
    expect(nzbFile).toBeNull();
    const job = await prisma.downloadJob.findUnique({ where: { id: jobId } });
    expect(job).toBeNull();

    // Physical NZB delete triggered (fire-and-forget — use waitFor so the
    // test doesn't race on slow CI).
    await vi.waitFor(() => {
      expect(mockDeleteNzbFromService).toHaveBeenCalledWith(hash);
    });
  });

  it("expires one job but keeps the NzbFile when another active job remains", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const hash = "cleanup-shared-" + Date.now();

    const { jobId: jobAId, nzbFileId } = await createNeedsReviewJob({
      userId: userA.id,
      hash,
      reviewExpiresAt: past,
    });
    const { jobId: jobBId } = await createNeedsReviewJob({
      userId: userB.id,
      hash: "unused",
      reviewExpiresAt: future, // still has time
      sharedNzbFileId: nzbFileId,
    });

    const result = emptyResult();
    await cleanupExpiredReviews(result);

    expect(result.expired).toBe(1);
    expect(result.orphansDeleted).toBe(0);

    // Job A terminal, Job B untouched
    const jobA = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobAId } });
    const jobB = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobBId } });
    expect(jobA.status).toBe("expired");
    expect(jobB.status).toBe("needs_review");

    // NzbFile still exists
    const nzbFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });
    expect(nzbFile).not.toBeNull();

    // Physical NZB NOT deleted — the fire-and-forget branch is never even
    // reached when the cleanup keeps the NzbFile, so this is a synchronous
    // negative assertion, no waiting needed.
    expect(mockDeleteNzbFromService).not.toHaveBeenCalled();
  });

  it("expires a job but keeps the NzbFile when it got assigned in the meantime", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);
    const hash = "cleanup-assigned-" + Date.now();

    const { jobId, nzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash,
      reviewExpiresAt: past,
    });

    // Simulate another user assigning the NzbFile between the retry and cleanup.
    // The job itself is still needs_review (stuck), which is the realistic case.
    const movie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 555_555,
        titleDe: "Assigned Elsewhere",
        titleEn: "Assigned Elsewhere",
        year: 2020,
      },
    });
    await prisma.nzbFile.update({
      where: { id: nzbFileId },
      data: { movieId: movie.id },
    });

    const result = emptyResult();
    await cleanupExpiredReviews(result);

    // Job IS expired (we still cleaned up the stuck job record).
    // But the NzbFile is NOT deleted because it now has a movie.
    expect(result.expired).toBe(1);
    expect(result.orphansDeleted).toBe(0);

    const nzbFile = await prisma.nzbFile.findUniqueOrThrow({ where: { id: nzbFileId } });
    expect(nzbFile.movieId).toBe(movie.id);

    expect(mockDeleteNzbFromService).not.toHaveBeenCalled();
  });

  it("does not delete an NzbFile that has an s3Key (defensive)", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);
    const hash = "cleanup-s3-" + Date.now();

    const { jobId, nzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash,
      reviewExpiresAt: past,
    });

    // Set s3Key directly — shouldn't normally be possible for needs_review
    // but the guard must hold anyway.
    await prisma.nzbFile.update({
      where: { id: nzbFileId },
      data: { s3Key: `${hash}/${hash}.mkv`, s3Bucket: "openmedia-files" },
    });

    const result = emptyResult();
    await cleanupExpiredReviews(result);

    expect(result.expired).toBe(1);
    expect(result.orphansDeleted).toBe(0);

    const nzbFile = await prisma.nzbFile.findUnique({ where: { id: nzbFileId } });
    expect(nzbFile).not.toBeNull();

    expect(mockDeleteNzbFromService).not.toHaveBeenCalled();
  });

  it("ignores jobs whose reviewExpiresAt is still in the future", async () => {
    const user = await createUser();
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const { jobId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "cleanup-future-" + Date.now(),
      reviewExpiresAt: future,
    });

    const result = emptyResult();
    await cleanupExpiredReviews(result);

    expect(result.expired).toBe(0);
    expect(result.orphansDeleted).toBe(0);

    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("needs_review");
  });
});

describe("reconcileStaleJobs integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs TMDB retry, expired cleanup, and stale checks in one pass", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000);

    // Job 1: needs_review with elapsed tmdbRetryAfter → should be retried
    mockSearchTmdbMovie.mockResolvedValueOnce({
      status: "found",
      movie: {
        tmdbId: 111,
        imdbId: "tt0000111",
        titleDe: "Retry Movie",
        titleEn: "Retry Movie",
        description: "",
        year: 2020,
        posterPath: null,
      },
    });
    const { jobId: retryJobId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "integration-retry-" + Date.now(),
      originalFilename: "Retry.Movie.2020.nzb",
      tmdbRetryAfter: past,
    });

    // Job 2: needs_review with elapsed reviewExpiresAt → should be expired
    const { jobId: expireJobId, nzbFileId: expireNzbFileId } = await createNeedsReviewJob({
      userId: user.id,
      hash: "integration-expire-" + Date.now(),
      reviewExpiresAt: past,
    });

    const result = await reconcileStaleJobs();

    expect(result.tmdbRetried).toBe(1);
    expect(result.tmdbAutoAssigned).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.orphansDeleted).toBe(1);

    // Retry job flipped (still exists because its NzbFile was rescued)
    const retryJob = await prisma.downloadJob.findUniqueOrThrow({ where: { id: retryJobId } });
    expect(retryJob.status).toBe("queued");

    // Expire job + NzbFile both gone (cascade)
    const expireJob = await prisma.downloadJob.findUnique({ where: { id: expireJobId } });
    expect(expireJob).toBeNull();
    const expireNzbFile = await prisma.nzbFile.findUnique({ where: { id: expireNzbFileId } });
    expect(expireNzbFile).toBeNull();
  });
});
