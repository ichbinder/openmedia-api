import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { prisma } from "../test/setup.js";
import fixture from "./__fixtures__/treasure-maps-severance-s02e05.json";

vi.mock("./nzb-service.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, storeNzbInService: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("./tmdb.js", () => ({
  getTmdbEpisodeById: vi.fn(),
  getTmdbSeasonById: vi.fn(),
  searchTmdbShowEpisode: vi.fn(),
}));

vi.mock("./treasure-maps.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, searchEpisode: vi.fn(), downloadNzb: vi.fn(), getDownloadBudget: vi.fn() };
});

import { getTmdbEpisodeById, getTmdbSeasonById } from "./tmdb.js";
import { downloadNzb, getDownloadBudget, IndexerError, searchEpisode, toRelease } from "./treasure-maps.js";
import { fulfillEpisodeRequest, requestEpisodes, syncEpisodeRequests } from "./episode-requests.js";

const mockEpisode = vi.mocked(getTmdbEpisodeById);
const mockSeason = vi.mocked(getTmdbSeasonById);
const mockSearch = vi.mocked(searchEpisode);
const mockDownload = vi.mocked(downloadNzb);
const mockBudget = vi.mocked(getDownloadBudget);

const releases = (fixture.items as Parameters<typeof toRelease>[0][]).map(toRelease);
const BEST = "17c315c99a4b4156c247920a62c3f240";
const SECOND = "73af81be3e25e88f019798d63595c6cb";
const show = { tmdbId: 95396, titleDe: "Severance", titleEn: "Severance", description: "", year: 2022, posterPath: null };

function nzb(guid: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="a@b.c" date="1" subject="${guid} [1/1] &quot;x.rar&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="1" number="1">${guid}@test.com</segment></segments>
  </file>
</nzb>`;
}

let counter = 0;
function createUser() {
  counter++;
  return prisma.user.create({ data: { email: `req-${counter}-${Date.now()}@test.de`, name: "U", password: "x" } });
}

async function createRequest(userId: string, episodeId: string, data: Record<string, unknown>, staleMinutes = 0) {
  const req = await prisma.episodeRequest.create({ data: { userId, episodeId, ...data } });
  if (staleMinutes) {
    await prisma.$executeRaw`UPDATE episode_requests SET updated_at = now() - make_interval(mins => ${staleMinutes}) WHERE id = ${req.id}`;
  }
  return req;
}

async function createEpisodeRow() {
  const nzbShow = await prisma.nzbShow.create({ data: { tmdbId: 95396, titleDe: "Severance", titleEn: "Severance" } });
  return prisma.nzbEpisode.create({ data: { showId: nzbShow.id, season: 2, episode: 5 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEpisode.mockResolvedValue({
    status: "found",
    show,
    episode: { titleDe: "Folge 5", airDate: "2025-02-14", runtime: 50 },
  });
  mockSearch.mockResolvedValue(releases);
  mockDownload.mockImplementation(async (guid) => nzb(guid));
  mockBudget.mockResolvedValue({ used: 0, max: 400 });
});

describe("requestEpisodes for one episode", () => {
  it("downloads the best German release and marks the request downloading", async () => {
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2, 5);

    expect(views).toEqual([{ season: 2, episode: 5, status: "downloading", waitReason: null }]);
    const jobs = await prisma.downloadJob.findMany({ include: { nzbFile: true } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].nzbFile.indexerGuid).toBe(BEST);
    expect(jobs[0].userId).toBe(user.id);
    const req = await prisma.episodeRequest.findFirstOrThrow();
    expect(req.nzbFileId).toBe(jobs[0].nzbFileId);
  });

  it("shares one download between two users and adds it to both libraries", async () => {
    const a = await createUser();
    const b = await createUser();

    await requestEpisodes(a.id, 95396, 2, 5);
    const viewsB = await requestEpisodes(b.id, 95396, 2, 5);

    expect(viewsB[0].status).toBe("downloading");
    expect(await prisma.downloadJob.count()).toBe(1);
    const file = await prisma.nzbFile.findFirstOrThrow();
    await prisma.nzbFile.update({ where: { id: file.id }, data: { s3Key: "media/x.mkv" } });

    await syncEpisodeRequests();

    const requests = await prisma.episodeRequest.findMany();
    expect(requests.map((r) => r.status)).toEqual(["done", "done"]);
    const library = await prisma.userLibrary.findMany({ where: { nzbFileId: file.id } });
    expect(library.map((l) => l.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it("waits with reason budget when the daily limit is nearly used", async () => {
    mockBudget.mockResolvedValue({ used: 350, max: 400 });
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2, 5);

    expect(views).toEqual([{ season: 2, episode: 5, status: "waiting", waitReason: "budget" }]);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("waits with reason no_german for about an hour without German releases", async () => {
    mockSearch.mockResolvedValue(releases.map((r) => ({ ...r, audioLanguages: ["English"] })));
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2, 5);

    expect(views[0]).toMatchObject({ status: "waiting", waitReason: "no_german" });
    const req = await prisma.episodeRequest.findFirstOrThrow();
    const delta = req.nextSearchAt!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(59 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("loads the next candidate when the first NZB is a known broken file", async () => {
    const episode = await createEpisodeRow();
    await prisma.nzbFile.create({
      data: {
        hash: createHash("sha256").update(nzb(BEST)).digest("hex"),
        originalFilename: "old.nzb",
        status: "broken",
        episodeId: episode.id,
      },
    });
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2, 5);

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual([BEST, SECOND]);
    expect(views[0].status).toBe("downloading");
    const job = await prisma.downloadJob.findFirstOrThrow({ include: { nzbFile: true } });
    expect(job.nzbFile.indexerGuid).toBe(SECOND);
  });

  it("stops before the next NZB once the budget threshold is crossed", async () => {
    const episode = await createEpisodeRow();
    await prisma.nzbFile.create({
      data: {
        hash: createHash("sha256").update(nzb(BEST)).digest("hex"),
        originalFilename: "old.nzb",
        status: "broken",
        episodeId: episode.id,
      },
    });
    mockBudget.mockResolvedValueOnce({ used: 0, max: 400 }).mockResolvedValue({ used: 350, max: 400 });
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2, 5);

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual([BEST]);
    expect(views[0]).toMatchObject({ status: "waiting", waitReason: "budget" });
  });

  it("clears an old manual pick on an automatic re-request", async () => {
    mockSearch.mockResolvedValue([]);
    const user = await createUser();
    await requestEpisodes(user.id, 95396, 2, 5, SECOND);
    expect((await prisma.episodeRequest.findFirstOrThrow()).manualGuid).toBe(SECOND);

    await requestEpisodes(user.id, 95396, 2, 5);

    expect((await prisma.episodeRequest.findFirstOrThrow()).manualGuid).toBeNull();
  });
});

describe("fulfillEpisodeRequest", () => {
  it("lets only one of two concurrent calls work on a waiting request", async () => {
    const episode = await createEpisodeRow();
    const user = await createUser();
    const req = await createRequest(user.id, episode.id, { status: "waiting", nextSearchAt: new Date(Date.now() - 1000) });

    await Promise.all([fulfillEpisodeRequest(req.id), fulfillEpisodeRequest(req.id)]);

    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect((await prisma.episodeRequest.findFirstOrThrow()).status).toBe("downloading");
  });
});

describe("requestEpisodes for a season", () => {
  it("requests only episodes that have aired", async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    mockSeason.mockResolvedValue({
      status: "found",
      show,
      episodes: [
        { episode: 1, titleDe: "Eins", airDate: "2025-01-17", runtime: 50 },
        { episode: 2, titleDe: "Zwei", airDate: "2025-01-24", runtime: 50 },
        { episode: 3, titleDe: "Drei", airDate: tomorrow, runtime: 50 },
      ],
    });
    mockSearch.mockResolvedValue([]);
    const user = await createUser();

    const views = await requestEpisodes(user.id, 95396, 2);

    expect(views).toEqual([
      { season: 2, episode: 1, status: "searching", waitReason: null },
      { season: 2, episode: 2, status: "searching", waitReason: null },
    ]);
    await vi.waitFor(async () => {
      expect(await prisma.episodeRequest.count({ where: { status: "waiting" } })).toBe(2);
    });
  });
});

describe("syncEpisodeRequests", () => {
  it("expires waiting requests older than 30 days without searching", async () => {
    const episode = await createEpisodeRow();
    const user = await createUser();
    await prisma.episodeRequest.create({
      data: {
        userId: user.id,
        episodeId: episode.id,
        status: "waiting",
        waitReason: "no_german",
        nextSearchAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    });

    await syncEpisodeRequests();

    expect((await prisma.episodeRequest.findFirstOrThrow()).status).toBe("expired");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("recovers stale searching requests and leaves fresh ones alone", async () => {
    const episode = await createEpisodeRow();
    const [stale, fresh, old] = [await createUser(), await createUser(), await createUser()];
    const staleReq = await createRequest(stale.id, episode.id, { status: "searching" }, 20);
    const freshReq = await createRequest(fresh.id, episode.id, { status: "searching" });
    const oldReq = await createRequest(
      old.id,
      episode.id,
      { status: "searching", createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
      20,
    );

    await syncEpisodeRequests();

    const byId = async (id: string) => (await prisma.episodeRequest.findUniqueOrThrow({ where: { id } })).status;
    expect(await byId(staleReq.id)).toBe("downloading");
    expect(await byId(freshReq.id)).toBe("searching");
    expect(await byId(oldReq.id)).toBe("expired");
  });

  it("stops the run after the first indexer error", async () => {
    mockSearch.mockRejectedValue(new IndexerError("http", 500));
    const episode = await createEpisodeRow();
    const [a, b] = [await createUser(), await createUser()];
    const due = { status: "waiting", nextSearchAt: new Date(Date.now() - 1000) };
    const first = await createRequest(a.id, episode.id, { ...due, createdAt: new Date(Date.now() - 60_000) });
    const second = await createRequest(b.id, episode.id, due);

    await syncEpisodeRequests();

    expect(mockSearch).toHaveBeenCalledTimes(1);
    const firstAfter = await prisma.episodeRequest.findUniqueOrThrow({ where: { id: first.id } });
    expect(firstAfter).toMatchObject({ status: "waiting", waitReason: "indexer_error" });
    const secondAfter = await prisma.episodeRequest.findUniqueOrThrow({ where: { id: second.id } });
    expect(secondAfter.nextSearchAt!.getTime()).toBeLessThan(Date.now());
  });

  it("puts a downloading request back to waiting when its job failed", async () => {
    const episode = await createEpisodeRow();
    const user = await createUser();
    const file = await prisma.nzbFile.create({ data: { hash: "h-failed", originalFilename: "f.nzb", episodeId: episode.id } });
    await prisma.downloadJob.create({ data: { nzbFileId: file.id, userId: user.id, status: "failed" } });
    await prisma.episodeRequest.create({
      data: { userId: user.id, episodeId: episode.id, status: "downloading", nzbFileId: file.id },
    });

    await syncEpisodeRequests();

    const req = await prisma.episodeRequest.findFirstOrThrow();
    expect(req.status).toBe("waiting");
    expect(req.nextSearchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
