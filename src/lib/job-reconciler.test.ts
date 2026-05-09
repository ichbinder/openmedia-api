import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock prisma before importing the module under test
vi.mock("./prisma.js", () => ({
  default: {
    downloadJob: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

// Mock hetzner
vi.mock("./hetzner.js", () => ({
  isHetznerConfigured: vi.fn(() => true),
  getServer: vi.fn(),
  deleteServer: vi.fn(),
  listServers: vi.fn(() => []),
}));

// Mock job-failure helper — reconciler delegates to it
vi.mock("./job-failure.js", () => ({
  markJobFailed: vi.fn(),
}));

import prisma from "./prisma.js";
import { getServer, deleteServer, listServers, isHetznerConfigured } from "./hetzner.js";
import { markJobFailed } from "./job-failure.js";
import { reconcileStaleJobs, _resetProgressSnapshotsForTests } from "./job-reconciler.js";

const mockPrisma = prisma as any;
const mockGetServer = getServer as any;
const mockDeleteServer = deleteServer as any;
const mockListServers = listServers as any;
const mockMarkJobFailed = markJobFailed as any;

function makeJob(overrides: Record<string, any> = {}) {
  const now = Date.now();
  return {
    id: "test-job-id",
    status: "provisioning",
    progress: 0,
    hetznerServerId: 12345,
    hetznerServerIp: "1.2.3.4",
    nzbFileId: "test-nzb-id",
    nzbFile: { hash: "abc123def456" },
    createdAt: new Date(now - 2 * 60 * 60 * 1000), // 2h ago
    updatedAt: new Date(now - 2 * 60 * 60 * 1000), // 2h ago
    ...overrides,
  };
}

/**
 * Set the active-jobs mock for the stale-check path. Call this in each test
 * that wants a specific set of active jobs returned.
 *
 * reconcileStaleJobs calls prisma.downloadJob.findMany three times per pass:
 *   1. retryTmdbForPendingReviews — needs_review + tmdbRetryAfter (S02)
 *   2. cleanupExpiredReviews     — needs_review + reviewExpiresAt (S02)
 *   3. stale check               — queued/provisioning/downloading/uploading
 *
 * This helper wires findMany to an implementation that returns empty for the
 * first two and the supplied `activeJobs` for the third.
 */
function mockActiveJobs(activeJobs: any[]) {
  mockPrisma.downloadJob.findMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    if (where.status === "needs_review") {
      // Either tmdbRetryAfter (retry path) or reviewExpiresAt (cleanup path)
      return Promise.resolve([]);
    }
    // The stale-check path asks for status: { in: [...] }
    if (where.status && typeof where.status === "object" && "in" in where.status) {
      return Promise.resolve(activeJobs);
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.downloadJob.updateMany.mockResolvedValue({ count: 1 });
  mockListServers.mockResolvedValue([]);
  // Default: helper successfully marks job as failed
  mockMarkJobFailed.mockResolvedValue({ changed: true, failedAttempts: 1, brokenNow: false });
  // Default: no active jobs — individual tests override via mockActiveJobs
  mockActiveJobs([]);
  // Reset progress-stagnation snapshot map between tests
  _resetProgressSnapshotsForTests();
});

describe("reconcileStaleJobs", () => {
  it("does nothing when no active jobs exist", async () => {
    mockActiveJobs([]);

    const result = await reconcileStaleJobs();

    expect(result.checked).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("fails a provisioning job when VPS is gone", async () => {
    mockActiveJobs([makeJob()]);
    mockGetServer.mockResolvedValue(null); // VPS not found

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("VPS gone");
    expect(mockMarkJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "test-job-id",
        source: "reconciler",
        expectedStatus: "provisioning",
      }),
    );
  });

  it("fails a job on hard timeout (4h+)", async () => {
    const now = Date.now();
    const job = makeJob({
      updatedAt: new Date(now - 5 * 60 * 60 * 1000), // 5h ago
    });
    mockActiveJobs([job]);

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("Hard timeout");
  });

  it("does not fail a recent job", async () => {
    const now = Date.now();
    const job = makeJob({
      updatedAt: new Date(now - 10 * 60 * 1000), // 10 min ago
    });
    mockActiveJobs([job]);
    mockGetServer.mockResolvedValue({ id: 12345, status: "running" });

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(0);
  });

  it("fails a stale queued job (never provisioned)", async () => {
    const now = Date.now();
    const job = makeJob({
      status: "queued",
      hetznerServerId: null,
      updatedAt: new Date(now - 2 * 60 * 60 * 1000), // 2h ago
    });
    mockActiveJobs([job]);

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("Stale queued");
  });

  it("cleans up zombie VPS for completed jobs", async () => {
    mockActiveJobs([]);
    mockListServers.mockResolvedValue([
      { id: 99, name: "dl-old", labels: { "job-id": "old-job-id" } },
    ]);
    mockPrisma.downloadJob.findUnique.mockResolvedValue({ status: "completed" });
    mockDeleteServer.mockResolvedValue(true);

    const result = await reconcileStaleJobs();

    expect(result.zombiesDeleted).toBe(1);
    expect(mockDeleteServer).toHaveBeenCalledWith(99);
  });

  it("fails a job when VPS is in 'off' status", async () => {
    mockActiveJobs([makeJob()]);
    mockGetServer.mockResolvedValue({ id: 12345, status: "off" });

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("VPS off");
  });

  it("fails a downloading job whose progress hasn't moved for 30+ minutes", async () => {
    // Two snapshots of the same job. First run records the 5%-snapshot,
    // second run (35min later) sees identical progress and triggers the
    // stagnation timeout. updatedAt is kept fresh on purpose — exactly the
    // case the new check is supposed to catch.
    const t0 = Date.now();
    const job1 = makeJob({
      status: "downloading",
      progress: 5,
      updatedAt: new Date(t0 - 60 * 1000), // 1min ago
    });
    mockActiveJobs([job1]);
    mockGetServer.mockResolvedValue({ id: 12345, status: "running" });

    const r1 = await reconcileStaleJobs();
    expect(r1.failed).toBe(0);

    // Advance virtual clock by 35min and run again with same progress.
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 35 * 60 * 1000);
    try {
      const job2 = makeJob({
        status: "downloading",
        progress: 5,
        updatedAt: new Date(t0 + 35 * 60 * 1000 - 60 * 1000), // still fresh
      });
      mockActiveJobs([job2]);

      const r2 = await reconcileStaleJobs();
      expect(r2.failed).toBe(1);
      expect(r2.details[0]).toContain("Progress stagnation");
      expect(mockMarkJobFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "test-job-id",
          source: "reconciler",
          expectedStatus: "downloading",
          error: expect.stringContaining("Fortschritt steckt"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flag stagnation when progress advances between runs", async () => {
    const t0 = Date.now();
    mockGetServer.mockResolvedValue({ id: 12345, status: "running" });

    mockActiveJobs([
      makeJob({ status: "downloading", progress: 10, updatedAt: new Date(t0 - 60 * 1000) }),
    ]);
    await reconcileStaleJobs();

    vi.useFakeTimers();
    vi.setSystemTime(t0 + 35 * 60 * 1000);
    try {
      // Progress moved from 10 → 40 within the window → snapshot resets
      mockActiveJobs([
        makeJob({
          status: "downloading",
          progress: 40,
          updatedAt: new Date(t0 + 35 * 60 * 1000 - 60 * 1000),
        }),
      ]);

      const r = await reconcileStaleJobs();
      expect(r.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply progress-stagnation to queued or provisioning jobs", async () => {
    // Provisioning at progress=0 for hours is normal (waiting on Hetzner).
    // Only the hard-timeout / VPS-gone paths should fail it, not stagnation.
    const t0 = Date.now();
    mockGetServer.mockResolvedValue({ id: 12345, status: "running" });

    mockActiveJobs([
      makeJob({ status: "provisioning", progress: 0, updatedAt: new Date(t0 - 60 * 1000) }),
    ]);
    await reconcileStaleJobs();

    vi.useFakeTimers();
    vi.setSystemTime(t0 + 35 * 60 * 1000);
    try {
      mockActiveJobs([
        makeJob({
          status: "provisioning",
          progress: 0,
          updatedAt: new Date(t0 + 35 * 60 * 1000 - 60 * 1000),
        }),
      ]);

      const r = await reconcileStaleJobs();
      expect(r.failed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
