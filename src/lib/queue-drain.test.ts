import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies before importing the module under test
vi.mock("./prisma.js", () => ({
  default: {
    downloadJob: {
      findFirst: vi.fn(),
    },
    uploadJob: {
      findFirst: vi.fn(),
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
}));

import prisma from "./prisma.js";
import { canProvision, getUploadVpsConfig } from "./vps-config.js";
import { provisionDownload } from "./provisioner.js";
import { isHetznerConfigured, provisionUploadVps } from "./hetzner.js";
import { storeServiceToken } from "./service-token.js";
import { drainQueue } from "./queue-drain.js";

const mockCanProvision = canProvision as any;
const mockProvisionDownload = provisionDownload as any;
const mockProvisionUploadVps = provisionUploadVps as any;
const mockGetUploadVpsConfig = getUploadVpsConfig as any;
const mockIsHetznerConfigured = isHetznerConfigured as any;
const mockStoreServiceToken = storeServiceToken as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsHetznerConfigured.mockReturnValue(true);
});

describe("drainQueue", () => {
  describe("download drain", () => {
    it("provisions the oldest queued download job when slot is available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // download check
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // upload check (no slot)

      (prisma.downloadJob.findFirst as any).mockResolvedValue({
        id: "dl-001",
        status: "queued",
        createdAt: new Date(),
      });

      mockProvisionDownload.mockResolvedValue(undefined);

      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledWith("download");
      expect(prisma.downloadJob.findFirst).toHaveBeenCalledWith({
        where: { status: "queued", hetznerServerId: null },
        orderBy: { createdAt: "asc" },
      });
      expect(mockProvisionDownload).toHaveBeenCalledWith("dl-001");
    });

    it("skips download drain when no slot available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false, reason: "Global limit reached" });
      mockCanProvision.mockResolvedValueOnce({ allowed: false });

      await drainQueue();

      expect(prisma.downloadJob.findFirst).not.toHaveBeenCalled();
      expect(mockProvisionDownload).not.toHaveBeenCalled();
    });

    it("skips download drain when no queued jobs", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: true });
      mockCanProvision.mockResolvedValueOnce({ allowed: false });

      (prisma.downloadJob.findFirst as any).mockResolvedValue(null);

      await drainQueue();

      expect(mockProvisionDownload).not.toHaveBeenCalled();
    });
  });

  describe("upload drain", () => {
    it("provisions the oldest queued upload job when slot is available", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // download (no slot)
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload

      (prisma.uploadJob.findFirst as any).mockResolvedValue({
        id: "up-001",
        status: "queued",
        nzbFile: { id: "nzb-1", hash: "abc12345deadbeef" },
      });

      mockGetUploadVpsConfig.mockResolvedValue({
        apiBaseUrl: "http://api:4000",
        dockerImage: "ghcr.io/test/uploader:latest",
      });

      mockProvisionUploadVps.mockResolvedValue({
        server: { id: 999, publicIpv4: "1.2.3.4", privateIp: "10.0.0.5" },
      });

      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledWith("upload");
      expect(prisma.uploadJob.findFirst).toHaveBeenCalledWith({
        where: { status: "queued", hetznerServerId: null },
        orderBy: { createdAt: "asc" },
        include: { nzbFile: true },
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

      expect(prisma.uploadJob.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("error isolation", () => {
    it("upload drain still runs if download drain throws", async () => {
      mockCanProvision.mockRejectedValueOnce(new Error("DB connection lost")); // download throws
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload succeeds

      (prisma.uploadJob.findFirst as any).mockResolvedValue(null);

      // Should not throw
      await drainQueue();

      expect(mockCanProvision).toHaveBeenCalledTimes(2);
    });

    it("does not mark upload job as failed if VPS creation fails", async () => {
      mockCanProvision.mockResolvedValueOnce({ allowed: false }); // download
      mockCanProvision.mockResolvedValueOnce({ allowed: true }); // upload

      (prisma.uploadJob.findFirst as any).mockResolvedValue({
        id: "up-002",
        status: "queued",
        nzbFile: { id: "nzb-2", hash: "deadbeef12345678" },
      });

      mockGetUploadVpsConfig.mockResolvedValue({
        apiBaseUrl: "http://api:4000",
        dockerImage: "ghcr.io/test/uploader:latest",
      });

      mockProvisionUploadVps.mockRejectedValue(new Error("Hetzner 503"));

      // Should not throw — job stays queued
      await drainQueue();

      expect(prisma.uploadJob.update).not.toHaveBeenCalled();
    });
  });
});
