import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../test/setup.js";
import { markJobFailed } from "./job-failure.js";

async function createTestJob(status: string = "provisioning") {
  const movie = await prisma.nzbMovie.create({
    data: { titleDe: "Test", titleEn: "Test", year: 2020 },
  });
  const nzbFile = await prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash: `hash-${Date.now()}-${Math.random()}`,
      originalFilename: "test.nzb",
    },
  });
  const job = await prisma.downloadJob.create({
    data: { nzbFileId: nzbFile.id, status },
  });
  return { movie, nzbFile, job };
}

describe("markJobFailed", () => {
  it("transitioniert Job zu failed und inkrementiert failedAttempts", async () => {
    const { nzbFile, job } = await createTestJob("provisioning");

    const result = await markJobFailed({
      jobId: job.id,
      error: "Hetzner API down",
      source: "test",
      expectedStatus: "provisioning",
    });

    expect(result.changed).toBe(true);
    expect(result.failedAttempts).toBe(1);
    expect(result.brokenNow).toBe(false);

    const updatedJob = await prisma.downloadJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("failed");
    expect(updatedJob?.error).toBe("Hetzner API down");
    expect(updatedJob?.completedAt).not.toBeNull();

    const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
    expect(updatedNzb?.failedAttempts).toBe(1);
    expect(updatedNzb?.status).toBe("untested");
  });

  it("markiert NzbFile als broken nach 3 Failures", async () => {
    const { nzbFile } = await createTestJob("provisioning");

    // Fail 3 fresh jobs for the same nzbFile
    for (let i = 0; i < 3; i++) {
      const job = await prisma.downloadJob.create({
        data: { nzbFileId: nzbFile.id, status: "provisioning" },
      });
      const result = await markJobFailed({
        jobId: job.id,
        error: `Failure ${i + 1}`,
        source: "test",
        expectedStatus: "provisioning",
      });
      expect(result.changed).toBe(true);
      expect(result.failedAttempts).toBe(i + 1);
    }

    const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
    expect(updatedNzb?.failedAttempts).toBe(3);
    expect(updatedNzb?.status).toBe("broken");
    expect(updatedNzb?.brokenReason).toContain("3x fehlgeschlagen");
  });

  it("respektiert CAS — überspringt wenn Status nicht passt", async () => {
    const { nzbFile, job } = await createTestJob("queued");

    const result = await markJobFailed({
      jobId: job.id,
      error: "wrong status",
      source: "test",
      expectedStatus: "downloading", // Job is "queued", not "downloading"
    });

    expect(result.changed).toBe(false);
    expect(result.failedAttempts).toBeUndefined();

    const updatedJob = await prisma.downloadJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.status).toBe("queued"); // Unchanged

    const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
    expect(updatedNzb?.failedAttempts).toBe(0); // Counter unchanged
  });

  it("verhindert Doppel-Inkrement bei bereits failed Job (default expectedStatus)", async () => {
    const { nzbFile, job } = await createTestJob("provisioning");

    // First failure
    const r1 = await markJobFailed({
      jobId: job.id,
      error: "first",
      source: "test",
      expectedStatus: "provisioning",
    });
    expect(r1.changed).toBe(true);
    expect(r1.failedAttempts).toBe(1);

    // Second attempt (without expectedStatus → uses default "not in completed/failed")
    const r2 = await markJobFailed({
      jobId: job.id,
      error: "second",
      source: "test",
    });

    // Should NOT increment because job is now in terminal state "failed"
    expect(r2.changed).toBe(false);

    const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
    expect(updatedNzb?.failedAttempts).toBe(1); // Still 1
  });

  it("speichert extraJobUpdate Felder", async () => {
    const { job } = await createTestJob("provisioning");

    const result = await markJobFailed({
      jobId: job.id,
      error: "with extras",
      source: "test",
      expectedStatus: "provisioning",
      extraJobUpdate: { progress: 42, hetznerServerId: 999999 },
    });

    expect(result.changed).toBe(true);

    const updatedJob = await prisma.downloadJob.findUnique({ where: { id: job.id } });
    expect(updatedJob?.progress).toBe(42);
    expect(updatedJob?.hetznerServerId).toBe(999999);
    expect(updatedJob?.status).toBe("failed");
  });

  it("brokenNow ist true bei Übergang zu broken", async () => {
    const { nzbFile, job } = await createTestJob("provisioning");

    // Pre-set failedAttempts to 2 — next failure crosses threshold
    await prisma.nzbFile.update({
      where: { id: nzbFile.id },
      data: { failedAttempts: 2 },
    });

    const result = await markJobFailed({
      jobId: job.id,
      error: "third strike",
      source: "test",
      expectedStatus: "provisioning",
    });

    expect(result.changed).toBe(true);
    expect(result.failedAttempts).toBe(3);
    expect(result.brokenNow).toBe(true);
  });
});
