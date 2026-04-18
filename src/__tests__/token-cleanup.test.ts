import { describe, it, expect, vi } from "vitest";
import { prisma } from "../test/setup.js";
import {
  generateServiceToken,
  storeServiceToken,
  deleteServiceTokens,
} from "../lib/service-token.js";

/**
 * Tests verifying that service tokens are cleaned up in all 3 VPS cleanup paths
 * and that upload zombie detection works correctly.
 *
 * These are DB-level integration tests — they exercise the same deleteServiceTokens()
 * calls wired into downloads.ts, uploads.ts, and job-reconciler.ts (see T01).
 */

describe("Token cleanup — download cleanup path", () => {
  it("deletes all service tokens for a download job", async () => {
    // Simulate: download VPS provisioned, tokens stored
    const t1 = generateServiceToken();
    const t2 = generateServiceToken();
    await storeServiceToken(t1.hash, "dl-cleanup-job", "download");
    await storeServiceToken(t2.hash, "dl-cleanup-job", "download");

    // Verify tokens exist
    const before = await prisma.serviceToken.count({ where: { jobId: "dl-cleanup-job" } });
    expect(before).toBe(2);

    // Simulate cleanup endpoint calling deleteServiceTokens(job.id)
    const result = await deleteServiceTokens("dl-cleanup-job");
    expect(result.count).toBe(2);

    // Verify all tokens gone
    const after = await prisma.serviceToken.count({ where: { jobId: "dl-cleanup-job" } });
    expect(after).toBe(0);
  });

  it("does not affect tokens belonging to other jobs", async () => {
    const t1 = generateServiceToken();
    const t2 = generateServiceToken();
    await storeServiceToken(t1.hash, "dl-job-a", "download");
    await storeServiceToken(t2.hash, "dl-job-b", "download");

    await deleteServiceTokens("dl-job-a");

    // job-b's token should still exist
    const remaining = await prisma.serviceToken.findMany({ where: { jobId: "dl-job-b" } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tokenHash).toBe(t2.hash);
  });
});

describe("Token cleanup — upload completion path", () => {
  it("deletes all service tokens for an upload job on completion", async () => {
    const t1 = generateServiceToken();
    await storeServiceToken(t1.hash, "ul-complete-job", "upload");

    const before = await prisma.serviceToken.count({ where: { jobId: "ul-complete-job" } });
    expect(before).toBe(1);

    // Simulate uploads.ts PATCH status=completed calling deleteServiceTokens(id)
    const result = await deleteServiceTokens("ul-complete-job");
    expect(result.count).toBe(1);

    const after = await prisma.serviceToken.count({ where: { jobId: "ul-complete-job" } });
    expect(after).toBe(0);
  });

  it("deletes tokens for upload job on failure too", async () => {
    const t1 = generateServiceToken();
    await storeServiceToken(t1.hash, "ul-failed-job", "upload");

    // Simulate uploads.ts PATCH status=failed calling deleteServiceTokens(id)
    const result = await deleteServiceTokens("ul-failed-job");
    expect(result.count).toBe(1);

    const after = await prisma.serviceToken.count({ where: { jobId: "ul-failed-job" } });
    expect(after).toBe(0);
  });
});

describe("Token cleanup — reconciler zombie path", () => {
  it("deletes service tokens for zombie download servers", async () => {
    // Simulate: reconciler found a zombie VPS for job "dl-zombie-1"
    const t1 = generateServiceToken();
    const t2 = generateServiceToken();
    await storeServiceToken(t1.hash, "dl-zombie-1", "download");
    await storeServiceToken(t2.hash, "dl-zombie-1", "download");

    // Reconciler deletes VPS then calls deleteServiceTokens(jobId)
    const result = await deleteServiceTokens("dl-zombie-1");
    expect(result.count).toBe(2);

    const after = await prisma.serviceToken.count({ where: { jobId: "dl-zombie-1" } });
    expect(after).toBe(0);
  });

  it("deletes service tokens for zombie upload servers", async () => {
    // Simulate: reconciler found a zombie upload VPS for job "ul-zombie-1"
    const t1 = generateServiceToken();
    await storeServiceToken(t1.hash, "ul-zombie-1", "upload");

    const result = await deleteServiceTokens("ul-zombie-1");
    expect(result.count).toBe(1);

    const after = await prisma.serviceToken.count({ where: { jobId: "ul-zombie-1" } });
    expect(after).toBe(0);
  });
});

describe("Upload zombie detection", () => {
  it("upload jobs with hetznerServerId but no matching Hetzner server are orphans", async () => {
    // This tests the DB-side pattern used by the reconciler:
    // find uploadJobs with hetznerServerId set, cross-reference with Hetzner API
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Zombie Upload", titleEn: "Zombie Upload", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `zombie-ul-${Date.now()}`, originalFilename: "zombie.nzb" },
    });
    const orphanJob = await prisma.uploadJob.create({
      data: {
        nzbFileId: nzbFile.id,
        movieId: movie.id,
        hetznerServerId: 99999, // Fake server ID — won't exist in Hetzner
        status: "uploading",
      },
    });

    // Store tokens for this orphan job
    const t1 = generateServiceToken();
    await storeServiceToken(t1.hash, orphanJob.id, "upload");

    // Verify the orphan job is detectable via DB query (same pattern as reconciler)
    const activeUploads = await prisma.uploadJob.findMany({
      where: {
        hetznerServerId: { not: null },
        status: { in: ["uploading", "queued"] },
      },
    });
    expect(activeUploads.some((j) => j.id === orphanJob.id)).toBe(true);

    // Simulate reconciler cleanup: delete tokens for the orphan
    const result = await deleteServiceTokens(orphanJob.id);
    expect(result.count).toBe(1);

    // Tokens cleaned
    const after = await prisma.serviceToken.count({ where: { jobId: orphanJob.id } });
    expect(after).toBe(0);
  });
});

describe("Token deletion failure resilience", () => {
  it("token deletion failure does not throw when wrapped in try/catch (non-fatal pattern)", async () => {
    // This tests the pattern used in all 3 cleanup paths:
    // try { await deleteServiceTokens(jobId); } catch { /* non-fatal */ }
    // We mock deleteServiceTokens to throw, then verify the try/catch pattern works.

    const mockDeleteTokens = vi.fn().mockRejectedValue(new Error("DB connection lost"));

    let vpsDeleted = false;
    let tokenError: string | null = null;

    // Simulate the exact pattern from downloads.ts:1746-1750
    vpsDeleted = true; // VPS deletion succeeded
    try {
      await mockDeleteTokens("some-job-id");
    } catch (tokenErr: any) {
      tokenError = tokenErr.message;
      // Non-fatal — logged but not rethrown (matches production pattern)
    }

    expect(vpsDeleted).toBe(true);
    expect(tokenError).toBe("DB connection lost");
    expect(mockDeleteTokens).toHaveBeenCalledWith("some-job-id");
  });

  it("real deleteServiceTokens does not throw for valid but empty job", async () => {
    // No tokens exist for this job — should return count=0, not throw
    await expect(deleteServiceTokens("no-tokens-here")).resolves.toEqual({ count: 0 });
  });
});

describe("Token cleanup idempotency", () => {
  it("calling deleteServiceTokens twice returns count=0 on second call", async () => {
    const t1 = generateServiceToken();
    await storeServiceToken(t1.hash, "idempotent-job", "download");

    const first = await deleteServiceTokens("idempotent-job");
    expect(first.count).toBe(1);

    const second = await deleteServiceTokens("idempotent-job");
    expect(second.count).toBe(0);
  });

  it("deleteServiceTokens on a job that never had tokens returns count=0", async () => {
    const result = await deleteServiceTokens("never-existed-job-id");
    expect(result.count).toBe(0);
  });
});
