import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { prisma } from "../test/setup.js";
import type { IndexerRelease } from "./treasure-maps.js";

vi.mock("./nzb-service.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, storeNzbInService: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("./tmdb.js", () => ({
  searchTmdbMovieById: vi.fn(),
  getTmdbEpisodeById: vi.fn(),
  getTmdbSeasonById: vi.fn(),
}));

vi.mock("./treasure-maps.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, searchMovie: vi.fn(), downloadNzb: vi.fn(), getDownloadBudget: vi.fn() };
});

vi.mock("./download-jobs.js", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("./download-jobs.js");
  return { ...original, startDownloadJob: vi.fn(original.startDownloadJob) };
});

import { startDownloadJob } from "./download-jobs.js";
import { searchTmdbMovieById } from "./tmdb.js";
import { downloadNzb, getDownloadBudget, IndexerError, searchMovie } from "./treasure-maps.js";
import { listMovieCandidates, requestMovie } from "./movie-requests.js";

const mockTmdb = vi.mocked(searchTmdbMovieById);
const mockSearch = vi.mocked(searchMovie);
const mockDownload = vi.mocked(downloadNzb);
const mockBudget = vi.mocked(getDownloadBudget);

const matrix = {
  tmdbId: 603,
  imdbId: "tt0133093",
  titleDe: "Matrix",
  titleEn: "The Matrix",
  description: "",
  year: 1999,
  posterPath: null,
  runtime: 136,
};

function release(guid: string, over: Partial<IndexerRelease> = {}): IndexerRelease {
  return {
    guid,
    title: "The.Matrix.1999.German.DL.1080p.BluRay.x264-GRP",
    size: 4e9,
    postedAt: "2025-01-01",
    password: 0,
    season: null,
    episode: null,
    audioLanguages: ["German", "English"],
    subtitles: null,
    videoWidth: 1920,
    ...over,
  };
}

const DE1 = release("de1");
const DE2 = release("de2", { size: 5e9 });
const EN = release("en1080", { title: "The.Matrix.1999.1080p.BluRay.x264-GRP", audioLanguages: ["English"] });

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
  return prisma.user.create({ data: { email: `movie-req-${counter}-${Date.now()}@test.de`, name: "U", password: "x" } });
}

async function createOwnFile(data: Record<string, unknown> = {}) {
  const movie = await prisma.nzbMovie.create({ data: { tmdbId: 603, titleDe: "Matrix", titleEn: "The Matrix" } });
  return prisma.nzbFile.create({
    data: {
      hash: `h-${Math.random()}`,
      originalFilename: "The.Matrix.1999.German.1080p.BluRay.nzb",
      fileSize: BigInt(4e9),
      qualityTier: "1080p",
      movieId: movie.id,
      ...data,
    },
  });
}

function createBrokenNzb(guid: string) {
  return prisma.nzbFile.create({
    data: { hash: createHash("sha256").update(nzb(guid)).digest("hex"), originalFilename: "old.nzb", status: "broken" },
  });
}

const auto = { confirmed: false, manual: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockTmdb.mockResolvedValue({ status: "found", movie: matrix });
  mockSearch.mockResolvedValue([DE1]);
  mockDownload.mockImplementation(async (guid) => nzb(guid));
  mockBudget.mockResolvedValue({ used: 0, max: 400 });
});

describe("requestMovie", () => {
  it("one click on a German indexer hit downloads the NZB and starts a job", async () => {
    const u = await createUser();

    const outcome = await requestMovie(u.id, 603, "guid:de1", auto);

    const job = await prisma.downloadJob.findFirstOrThrow({ include: { nzbFile: true } });
    expect(outcome).toEqual({ status: "downloading", nzbFileId: job.nzbFileId });
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(job.userId).toBe(u.id);
    expect(job.nzbFile.indexerGuid).toBe("de1");
    expect(job.nzbFile.audioLanguages).toEqual(["de", "en"]);
    const req = await prisma.movieRequest.findFirstOrThrow();
    expect(req).toMatchObject({
      status: "downloading",
      allowedGroup: "german",
      nzbFileId: job.nzbFileId,
      attempts: 1,
      triedKeys: ["guid:de1"],
    });
  });

  it("asks before loading an English-only version", async () => {
    mockSearch.mockResolvedValue([EN]);
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:en1080", { confirmed: false, manual: false })).toEqual({
      status: "confirm_required",
      group: "foreign",
    });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(await prisma.movieRequest.count()).toBe(0);
  });

  it("loads an English-only version once confirmed", async () => {
    mockSearch.mockResolvedValue([EN]);
    const u = await createUser();

    const outcome = await requestMovie(u.id, 603, "guid:en1080", { confirmed: true, manual: false });

    expect(outcome.status).toBe("downloading");
    expect((await prisma.movieRequest.findFirstOrThrow()).allowedGroup).toBe("foreign");
  });

  it("ready own file returns ready and adds it to the library", async () => {
    mockSearch.mockResolvedValue([]);
    const file = await createOwnFile({ s3Key: "media/matrix.mkv" });
    const u = await createUser();

    expect(await requestMovie(u.id, 603, `file:${file.id}`, auto)).toEqual({ status: "ready", nzbFileId: file.id });

    expect(await prisma.userLibrary.findFirst({ where: { userId: u.id, nzbFileId: file.id } })).not.toBeNull();
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "done", nzbFileId: file.id });
  });

  it("own NZB without S3 starts a job without touching the indexer budget", async () => {
    mockSearch.mockResolvedValue([]);
    const file = await createOwnFile();
    const u = await createUser();

    expect(await requestMovie(u.id, 603, `file:${file.id}`, auto)).toEqual({ status: "downloading", nzbFileId: file.id });

    expect(mockBudget).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
    const job = await prisma.downloadJob.findFirstOrThrow();
    expect(job).toMatchObject({ nzbFileId: file.id, userId: u.id, status: "queued" });
  });

  it("stops at the budget reserve", async () => {
    mockBudget.mockResolvedValue({ used: 350, max: 400 });
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:de1", auto)).toEqual({ status: "budget" });

    expect(mockDownload).not.toHaveBeenCalled();
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "failed", failReason: "budget" });
  });

  it("unknown key returns candidate_gone", async () => {
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:gone", auto)).toEqual({ status: "candidate_gone" });

    expect(await prisma.movieRequest.count()).toBe(0);
  });

  it("broken ingest tries the next German candidate but never an English one", async () => {
    mockSearch.mockResolvedValue([DE1, DE2, EN]);
    await createBrokenNzb("de1");
    await createBrokenNzb("de2");
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:de1", auto)).toEqual({ status: "failed" });

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de1", "de2"]);
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({
      status: "failed",
      failReason: "no_candidate",
      attempts: 2,
      triedKeys: ["guid:de1", "guid:de2"],
    });
  });

  it("manual pick does not fall back to another version", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    await createBrokenNzb("de1");
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:de1", { confirmed: false, manual: true })).toEqual({ status: "failed" });

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de1"]);
    expect((await prisma.movieRequest.findFirstOrThrow()).manual).toBe(true);
  });

  it("stops after three attempts", async () => {
    mockSearch.mockResolvedValue([DE1, DE2, release("de3"), release("de4")]);
    for (const guid of ["de1", "de2", "de3", "de4"]) await createBrokenNzb(guid);
    const u = await createUser();

    expect(await requestMovie(u.id, 603, "guid:de1", auto)).toEqual({ status: "failed" });

    expect(mockDownload).toHaveBeenCalledTimes(3);
  });

  it("second user clicking the same film shares the active job", async () => {
    const [a, b] = [await createUser(), await createUser()];

    const first = await requestMovie(a.id, 603, "guid:de1", auto);
    const second = await requestMovie(b.id, 603, "guid:de1", auto);

    expect(first).toEqual(second);
    expect(second.status).toBe("downloading");
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(await prisma.downloadJob.count()).toBe(1);
    const requests = await prisma.movieRequest.findMany();
    expect(requests.map((r) => [r.status, r.nzbFileId])).toEqual([
      ["downloading", (first as { nzbFileId: string }).nzbFileId],
      ["downloading", (first as { nzbFileId: string }).nzbFileId],
    ]);
  });

  it("two simultaneous clicks on the same own file share one job", async () => {
    mockSearch.mockResolvedValue([]);
    const file = await createOwnFile();
    const [a, b] = [await createUser(), await createUser()];

    const outcomes = await Promise.all([
      requestMovie(a.id, 603, `file:${file.id}`, auto),
      requestMovie(b.id, 603, `file:${file.id}`, auto),
    ]);

    expect(outcomes).toEqual([
      { status: "downloading", nzbFileId: file.id },
      { status: "downloading", nzbFileId: file.id },
    ]);
    expect(await prisma.downloadJob.count()).toBe(1);
    const requests = await prisma.movieRequest.findMany();
    expect(requests.map((r) => r.nzbFileId)).toEqual([file.id, file.id]);
  });

  it("treats a serialization failure while starting the job as a shared job", async () => {
    mockSearch.mockResolvedValue([]);
    const file = await createOwnFile();
    const u = await createUser();
    vi.mocked(startDownloadJob).mockRejectedValueOnce({ code: "P2034" });

    expect(await requestMovie(u.id, 603, `file:${file.id}`, auto)).toEqual({ status: "downloading", nzbFileId: file.id });

    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "downloading", nzbFileId: file.id });
  });

  it("throws TmdbUnavailableError when TMDB is down for an indexer ingest", async () => {
    mockTmdb.mockResolvedValue({ status: "error", reason: "timeout" });
    const u = await createUser();

    await expect(requestMovie(u.id, 603, "guid:de1", auto)).rejects.toMatchObject({ name: "TmdbUnavailableError" });
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("listMovieCandidates", () => {
  it("shows own files when the indexer is unavailable", async () => {
    mockSearch.mockRejectedValue(new IndexerError("not_configured"));
    const file = await createOwnFile();

    const { candidates, indexer } = await listMovieCandidates(603);

    expect(indexer).toBe("unavailable");
    expect(candidates.map((c) => c.key)).toEqual([`file:${file.id}`]);
  });

  it("hides indexer hits that are known broken NZBs", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    await prisma.nzbFile.create({ data: { hash: "h-broken", originalFilename: "x.nzb", status: "broken", indexerGuid: "de2" } });

    const { candidates, indexer } = await listMovieCandidates(603);

    expect(indexer).toBe("ok");
    expect(candidates.map((c) => c.key)).toEqual(["guid:de1"]);
  });
});
