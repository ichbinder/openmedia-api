import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies before importing the module under test
vi.mock("./prisma.js", () => ({
  default: {
    downloadJob: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    uploadJob: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("./vps-config.js", () => ({
  canProvision: vi.fn(),
  getUploadVpsConfig: vi.fn(),
}));

vi.mock("./provisioner.js", () => ({
  provisionDownload: vi.fn(),
}));

vi.mock("./hetzner.js", () => ({
  isHetznerConfigured: vi.fn().mockReturnValue(true),
  provisionUploadVps: vi.fn(),
}));

vi.mock("./service-token.js", () => ({
  generateServiceToken: vi.fn().mockReturnValue({ plaintext: "tok-abc", hash: "hash-abc" }),
  storeServiceToken: vi.fn(),
  deleteServiceTokens: vi.fn(),
}));

import prisma from "./prisma.js";
import { canProvision, getUploadVpsConfig } from "./vps-config.js";
import { provisionDownload } from "./provisioner.js";
import { isHetznerConfigured, provisionUploadVps } from "./hetzner.js";
import { storeServiceToken, deleteServiceTokens } from "./service-token.js";
import { drainQueue } from "./queue-drain.js";

const mockCanProvision = canProvision as any;
const mockProvisionDownload = provisionDownload as any;
const mockProvisionUploadVps = provisionUploadVps as any;
const mockGetUploadVpsConfig = getUploadVpsConfig as any;
const mockIsHetznerConfigured = isHetznerConfigured as any;
const mockStoreServiceToken = storeServiceToken as any;
const mockDeleteServiceTokens = deleteServiceTokens as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsHetznerConfigured.mockReturnValue(true);
});

describe("drainQueue", () => {
  describe("download drain", () => {
    it("provisions the oldest queued download job when slot is available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // download check
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // upload check (no slot)

      (prisma.downloadJob.findMany as any).mockResolvedValue([{
        id: "dl-001",
        status: "queued",
        createdAt: new Date(),
      }]);

      (prisma.downloadJob.updateMany as any).mockResolvedValue({ count: 1 });
      mockProvisionDownload.mockResolvedValue(undefined);

      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledWith("download");
      expect(prisma.downloadJob.findMany).toHaveBeenCalledWith({
        where: { status: "queued", hetznerServerId: null },
        orderBy: { createdAt: "asc" },
        take: 1,
      });
      expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
        where: { id: "dl-001", status: "queued", hetznerServerId: null },
        data: { status: "provisioning" },
      });
      expect(mockProvisionDownload).toHaveBeenCalledWith("dl-001");
    });

    it("skips download drain when no slot available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false, reason: "Global limit reached" });
      mockCanProvision.mockResolvedValueOnce({ allowed: false });

      await drainQueue();

      expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
      expect(mockProvisionDownload).not.toHaveBeenCalled();
    });

    it("skips download drain when no queued jobs", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: true });
      mockCanProvision.mockResolvedValueOnce({ allowed: false });

      (prisma.downloadJob.findMany as any).mockResolvedValue([]);

      await drainQueue();

      expect(mockProvisionDownload).not.toHaveBeenCalled();
    });

    it("skips if another drain already claimed the job (CAS miss)", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: true });
      mockCanProvision.mockResolvedValueOnce({ allowed: false });

      (prisma.downloadJob.findMany as any).mockResolvedValue([{
        id: "dl-002",
        status: "queued",
      }]);

      // Another drain already claimed it
      (prisma.downloadJob.updateMany as any).mockResolvedValue({ count: 0 });

      await drainQueue();

      expect(mockProvisionDownload).not.toHaveBeenCalled();
    });
  });

  describe("upload drain", () => {
    it("provisions the oldest queued upload job when slot is available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // download (no slot)
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload

      (prisma.uploadJob.findMany as any).mockResolvedValue([{
        id: "up-001",
        status: "queued",
        nzbFile: { id: "nzb-1", hash: "abc12345deadbeef" },
      }]);

      (prisma.uploadJob.updateMany as any).mockResolvedValue({ count: 1 });

      mockGetUploadVpsConfig.mockResolvedValue({
        apiBaseUrl: "http://api:4000",
        dockerImage: "ghcr.io/test/uploader:latest",
      });

      mockProvisionUploadVps.mockResolvedValue({
        server: { id: 999, publicIpv4: "1.2.3.4", privateIp: "10.0.0.5" },
      });

      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledWith("upload");
      expect(prisma.uploadJob.findMany).toHaveBeenCalledWith({
        where: { status: "queued", hetznerServerId: null },
        orderBy: { createdAt: "asc" },
        take: 1,
        include: { nzbFile: true },
      });
      expect(prisma.uploadJob.updateMany).toHaveBeenCalledWith({
        where: { id: "up-001", status: "queued", hetznerServerId: null },
        data: { status: "provisioning" },
      });
      expect(mockStoreServiceToken).toHaveBeenCalledWith("hash-abc", "up-001", "upload");
      expect(mockProvisionUploadVps).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "up-001",
          nzbFileHash: "abc12345deadbeef",
          serverName: "up-abc12345",
        }),
      );
      expect(prisma.uploadJob.update).toHaveBeenCalledWith({
        where: { id: "up-001" },
        data: expect.objectContaining({
          status: "running",
          hetznerServerId: 999,
          hetznerServerIp: "10.0.0.5",
        }),
      });
    });

    it("skips upload drain when no slot available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // download
      mockCanProvision.mockResolvedValueOnce({ allowed: false, reason: "Upload limit" }); // upload

      await drainQueue();

      expect(prisma.uploadJob.findMany).not.toHaveBeenCalled();
    });

    it("rolls back token and resets to queued when VPS creation fails", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // download
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload

      (prisma.uploadJob.findMany as any).mockResolvedValue([{
        id: "up-002",
        status: "queued",
        nzbFile: { id: "nzb-2", hash: "deadbeef12345678" },
      }]);

      (prisma.uploadJob.updateMany as any).mockResolvedValue({ count: 1 });

      mockGetUploadVpsConfig.mockResolvedValue({
        apiBaseUrl: "http://api:4000",
        dockerImage: "ghcr.io/test/uploader:latest",
      });

      mockProvisionUploadVps.mockRejectedValue(new Error("Hetzner 503"));

      // Should not throw — job resets to queued
      await drainQueue();

      expect(prisma.uploadJob.update).not.toHaveBeenCalled();
      expect(mockDeleteServiceTokens).toHaveBeenCalledWith("up-002");
      // Verify reset to queued
      expect(prisma.uploadJob.updateMany).toHaveBeenCalledWith({
        where: { id: "up-002", status: "provisioning" },
        data: { status: "queued" },
      });
    });
  });

  describe("error isolation", () => {
    it("upload drain still runs if download drain throws", async () => {
      mockCanProvision.mockRejectedValueOnce(new Error("DB connection lost")); // download throws
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload succeeds

      (prisma.uploadJob.findMany as any).mockResolvedValue([]);

      // Should not throw
      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledTimes(2);
    });
  });
});
