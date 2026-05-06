import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("./prisma.js", () => ({
  default: {
    downloadJob: { count: vi.fn() },
    uploadJob: { count: vi.fn() },
  },
}));

// Mock config-service
vi.mock("./config-service.js", () => ({
  getProfileConfig: vi.fn(),
  getEntry: vi.fn(),
}));

// Mock other dependencies (needed by module-level imports)
vi.mock("./usenet-provider-service.js", () => ({
  getDownloadProviders: vi.fn().mockResolvedValue([]),
  getUploadProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock("./vpn-config.js", () => ({
  resolveVpnConfig: vi.fn().mockResolvedValue(null),
}));

import prisma from "./prisma.js";
import { getEntry } from "./config-service.js";
import { getVpsLimits, getActiveVpsCounts, canProvision } from "./vps-config.js";

const mockGetEntry = vi.mocked(getEntry);
const mockDownloadCount = vi.mocked(prisma.downloadJob.count);
const mockUploadCount = vi.mocked(prisma.uploadJob.count);

describe("VPS Limits (Concurrency Gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getVpsLimits", () => {
    it("returns defaults when no config entries exist", async () => {
      mockGetEntry.mockResolvedValue(null as any);

      const limits = await getVpsLimits();
      expect(limits).toEqual({ globalLimit: 10, maxUploadVps: 3 });
    });

    it("reads config values from DB", async () => {
      mockGetEntry.mockImplementation(async (_cat: string, key: string) => {
        if (key === "globalLimit") return { value: "5" } as any;
        if (key === "maxUploadVps") return { value: "2" } as any;
        return null;
      });

      const limits = await getVpsLimits();
      expect(limits).toEqual({ globalLimit: 5, maxUploadVps: 2 });
    });

    it("clamps maxUploadVps to globalLimit", async () => {
      mockGetEntry.mockImplementation(async (_cat: string, key: string) => {
        if (key === "globalLimit") return { value: "3" } as any;
        if (key === "maxUploadVps") return { value: "5" } as any;
        return null;
      });

      const limits = await getVpsLimits();
      expect(limits).toEqual({ globalLimit: 3, maxUploadVps: 3 });
    });

    it("ignores invalid values and uses defaults", async () => {
      mockGetEntry.mockImplementation(async (_cat: string, key: string) => {
        if (key === "globalLimit") return { value: "abc" } as any;
        if (key === "maxUploadVps") return { value: "-1" } as any;
        return null;
      });

      const limits = await getVpsLimits();
      expect(limits).toEqual({ globalLimit: 10, maxUploadVps: 3 });
    });

    it("falls back to defaults on DB error", async () => {
      mockGetEntry.mockRejectedValue(new Error("DB connection failed"));

      const limits = await getVpsLimits();
      expect(limits).toEqual({ globalLimit: 10, maxUploadVps: 3 });
    });
  });

  describe("getActiveVpsCounts", () => {
    it("counts active download and upload VPS", async () => {
      mockDownloadCount.mockResolvedValue(3);
      mockUploadCount.mockResolvedValue(2);

      const counts = await getActiveVpsCounts();
      expect(counts).toEqual({ downloads: 3, uploads: 2, total: 5 });
    });

    it("returns zeros when no active VPS", async () => {
      mockDownloadCount.mockResolvedValue(0);
      mockUploadCount.mockResolvedValue(0);

      const counts = await getActiveVpsCounts();
      expect(counts).toEqual({ downloads: 0, uploads: 0, total: 0 });
    });
  });

  describe("canProvision", () => {
    beforeEach(() => {
      // Default: limits 10/3, no active VPS
      mockGetEntry.mockResolvedValue(null as any);
      mockDownloadCount.mockResolvedValue(0);
      mockUploadCount.mockResolvedValue(0);
    });

    it("allows download when under limits", async () => {
      const result = await canProvision("download");
      expect(result.allowed).toBe(true);
    });

    it("allows upload when under limits", async () => {
      const result = await canProvision("upload");
      expect(result.allowed).toBe(true);
    });

    it("blocks download when global limit reached", async () => {
      mockDownloadCount.mockResolvedValue(7);
      mockUploadCount.mockResolvedValue(3);

      const result = await canProvision("download");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Global VPS limit");
    });

    it("blocks upload when global limit reached", async () => {
      mockDownloadCount.mockResolvedValue(7);
      mockUploadCount.mockResolvedValue(3);

      const result = await canProvision("upload");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Global VPS limit");
    });

    it("blocks upload when upload limit reached", async () => {
      mockUploadCount.mockResolvedValue(3); // maxUploadVps default = 3

      const result = await canProvision("upload");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Upload VPS limit");
    });

    it("blocks download when download slots exhausted", async () => {
      // global=10, maxUpload=3, so maxDownload=7
      mockDownloadCount.mockResolvedValue(7);

      const result = await canProvision("download");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Download VPS limit");
    });

    it("allows download when uploads are at max but download slots remain", async () => {
      mockUploadCount.mockResolvedValue(3); // at upload limit
      mockDownloadCount.mockResolvedValue(2); // under download limit (7)

      const result = await canProvision("download");
      expect(result.allowed).toBe(true);
    });

    it("includes counts and limits in result", async () => {
      mockDownloadCount.mockResolvedValue(2);
      mockUploadCount.mockResolvedValue(1);

      const result = await canProvision("download");
      expect(result.counts).toEqual({ downloads: 2, uploads: 1, total: 3 });
      expect(result.limits).toEqual({ globalLimit: 10, maxUploadVps: 3 });
    });

    it("respects custom limits from DB", async () => {
      mockGetEntry.mockImplementation(async (_cat: string, key: string) => {
        if (key === "globalLimit") return { value: "2" } as any;
        if (key === "maxUploadVps") return { value: "1" } as any;
        return null;
      });
      mockDownloadCount.mockResolvedValue(1); // maxDownload = 2-1 = 1

      const result = await canProvision("download");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Download VPS limit");
    });
  });
});
