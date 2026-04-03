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

import prisma from "./prisma.js";
import { getServer, deleteServer, listServers, isHetznerConfigured } from "./hetzner.js";
import { reconcileStaleJobs } from "./job-reconciler.js";

const mockPrisma = prisma as any;
const mockGetServer = getServer as any;
const mockDeleteServer = deleteServer as any;
const mockListServers = listServers as any;

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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.downloadJob.updateMany.mockResolvedValue({ count: 1 });
  mockListServers.mockResolvedValue([]);
});

describe("reconcileStaleJobs", () => {
  it("does nothing when no active jobs exist", async () => {
    mockPrisma.downloadJob.findMany.mockResolvedValue([]);

    const result = await reconcileStaleJobs();

    expect(result.checked).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("fails a provisioning job when VPS is gone", async () => {
    mockPrisma.downloadJob.findMany.mockResolvedValue([makeJob()]);
    mockGetServer.mockResolvedValue(null); // VPS not found

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("VPS gone");
    expect(mockPrisma.downloadJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "test-job-id", status: "provisioning" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("fails a job on hard timeout (4h+)", async () => {
    const now = Date.now();
    const job = makeJob({
      updatedAt: new Date(now - 5 * 60 * 60 * 1000), // 5h ago
    });
    mockPrisma.downloadJob.findMany.mockResolvedValue([job]);

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("Hard timeout");
  });

  it("does not fail a recent job", async () => {
    const now = Date.now();
    const job = makeJob({
      updatedAt: new Date(now - 10 * 60 * 1000), // 10 min ago
    });
    mockPrisma.downloadJob.findMany.mockResolvedValue([job]);
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
    mockPrisma.downloadJob.findMany.mockResolvedValue([job]);

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("Stale queued");
  });

  it("cleans up zombie VPS for completed jobs", async () => {
    mockPrisma.downloadJob.findMany.mockResolvedValue([]);
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
    mockPrisma.downloadJob.findMany.mockResolvedValue([makeJob()]);
    mockGetServer.mockResolvedValue({ id: 12345, status: "off" });

    const result = await reconcileStaleJobs();

    expect(result.failed).toBe(1);
    expect(result.details[0]).toContain("VPS off");
  });
});
