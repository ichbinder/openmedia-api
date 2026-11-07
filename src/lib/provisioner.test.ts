import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../test/setup.js";

vi.mock("./vps-config.js", () => ({
  getDownloadVpsConfig: vi.fn().mockResolvedValue(null),
  canProvision: vi.fn(),
  getDownloadVpsLocations: vi.fn(),
  getDownloadVpsServerTypes: vi.fn(),
}));

import { provisionDownload } from "./provisioner.js";

async function createJob(nzbFileData: Record<string, unknown>) {
  const nzbFile = await prisma.nzbFile.create({
    data: { hash: `prov-${Date.now()}-${Math.random()}`, originalFilename: "x.nzb", ...nzbFileData },
  });
  return prisma.downloadJob.create({ data: { nzbFileId: nzbFile.id, status: "queued" } });
}

describe("provisionDownload", () => {
  beforeEach(() => {
    process.env.AUTO_PROVISION = "local";
  });

  it("provisions a queued job whose NzbFile has an episode", async () => {
    const show = await prisma.nzbShow.create({ data: { tmdbId: 880_001, titleDe: "S", titleEn: "Severance", year: 2022 } });
    const episode = await prisma.nzbEpisode.create({ data: { showId: show.id, season: 2, episode: 5 } });
    const job = await createJob({ episodeId: episode.id });

    await provisionDownload(job.id);

    const after = await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("failed");
    expect(after.error).toContain("Missing download config");
  });

  it("skips a queued job without movie and episode", async () => {
    const job = await createJob({});

    await provisionDownload(job.id);

    const after = await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe("queued");
  });
});
