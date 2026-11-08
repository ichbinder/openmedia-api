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
import { listMovieCandidates, requestMovie, syncMovieRequests } from "./movie-requests.js";

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
const CAM_DE = release("decam", { title: "The.Matrix.1999.German.HDCAM.x264-GRP", audioLanguages: ["German"] });
const CAM_EN = release("encam", { title: "The.Matrix.1999.HDCAM.x264-GRP", audioLanguages: ["English"] });

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
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ allowedGroup: "foreign", germanOnly: false });
  });

  it("keeps a confirmed German cam German-only but not an English cam", async () => {
    mockSearch.mockResolvedValue([CAM_DE, CAM_EN]);
    const [a, b] = [await createUser(), await createUser()];

    await requestMovie(a.id, 603, "guid:decam", { confirmed: true, manual: false });
    await requestMovie(b.id, 603, "guid:encam", { confirmed: true, manual: false });

    const byUser = async (userId: string) => prisma.movieRequest.findFirstOrThrow({ where: { userId } });
    expect(await byUser(a.id)).toMatchObject({ allowedGroup: "cam", germanOnly: true });
    expect(await byUser(b.id)).toMatchObject({ allowedGroup: "cam", germanOnly: false });
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

describe("syncMovieRequests", () => {
  async function createRequest(userId: string, data: Record<string, unknown>, staleMinutes = 0) {
    const req = await prisma.movieRequest.create({
      data: { userId, tmdbId: 603, status: "downloading", allowedGroup: "german", attempts: 1, triedKeys: ["guid:de1"], ...data },
    });
    await prisma.$executeRaw`UPDATE movie_requests SET updated_at = now() - make_interval(mins => ${staleMinutes}) WHERE id = ${req.id}`;
    return prisma.movieRequest.findUniqueOrThrow({ where: { id: req.id } });
  }

  async function failedDownload(userId: string, guid = "de1") {
    const file = await prisma.nzbFile.create({ data: { hash: `h-${guid}`, originalFilename: `${guid}.nzb`, indexerGuid: guid } });
    await prisma.downloadJob.create({ data: { nzbFileId: file.id, userId, status: "failed" } });
    return file;
  }

  function germanCheck(audioLanguages: string[], guid = "de1") {
    return prisma.nzbFile.create({
      data: { hash: `h-${Math.random()}`, originalFilename: `${guid}.nzb`, indexerGuid: guid, s3Key: "media/x.mkv", mediaInfo: {}, audioLanguages },
    });
  }

  it("adds the film to every requester's library when the shared job completes", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const file = await createOwnFile({ s3Key: "media/matrix.mkv" });
    await prisma.downloadJob.create({ data: { nzbFileId: file.id, userId: a.id, status: "completed" } });
    await createRequest(a.id, { nzbFileId: file.id });
    await createRequest(b.id, { nzbFileId: file.id });

    await syncMovieRequests();

    const requests = await prisma.movieRequest.findMany();
    expect(requests.map((r) => r.status)).toEqual(["done", "done"]);
    const library = await prisma.userLibrary.findMany({ where: { nzbFileId: file.id, removedAt: null } });
    expect(library.map((l) => l.userId).sort()).toEqual([a.id, b.id].sort());
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("retries the next German candidate after the job failed", async () => {
    mockSearch.mockResolvedValue([DE1, DE2, EN]);
    const u = await createUser();
    const failed = await failedDownload(u.id);
    await createRequest(u.id, { nzbFileId: failed.id });

    await syncMovieRequests();

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de2"]);
    const req = await prisma.movieRequest.findFirstOrThrow({ include: { nzbFile: true } });
    expect(req).toMatchObject({ status: "downloading", attempts: 2, triedKeys: ["guid:de1", "guid:de2"] });
    expect(req.nzbFile!.indexerGuid).toBe("de2");
  });

  it("retries a downloading request that never got a file once it is stale, not while a click is running", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    const [a, b] = [await createUser(), await createUser()];
    const stale = await createRequest(a.id, { nzbFileId: null }, 20);
    const running = await createRequest(b.id, { nzbFileId: null });

    await syncMovieRequests();

    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de2"]);
    expect(await prisma.movieRequest.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
      status: "downloading",
      attempts: 2,
    });
    expect(await prisma.movieRequest.findUniqueOrThrow({ where: { id: running.id } })).toEqual(running);
  });

  it("leaves a request alone while its job is still active", async () => {
    const u = await createUser();
    const file = await createOwnFile();
    await prisma.downloadJob.create({ data: { nzbFileId: file.id, userId: u.id, status: "needs_review" } });
    const request = await createRequest(u.id, { nzbFileId: file.id });

    await syncMovieRequests();

    expect(await prisma.movieRequest.findFirstOrThrow()).toEqual(request);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("marks a ffprobe-English 'German' file broken, removes it from the library and retries", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    const u = await createUser();
    const file = await germanCheck(["eng"]);
    await prisma.userLibrary.create({ data: { userId: u.id, nzbFileId: file.id } });
    await createRequest(u.id, { status: "done", nzbFileId: file.id });

    await syncMovieRequests();

    expect(await prisma.nzbFile.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
      status: "broken",
      brokenReason: "Kein deutscher Ton (ffprobe)",
    });
    expect((await prisma.userLibrary.findFirstOrThrow({ where: { nzbFileId: file.id } })).removedAt).not.toBeNull();
    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de2"]);
    const req = await prisma.movieRequest.findFirstOrThrow({ include: { nzbFile: true } });
    expect(req).toMatchObject({ status: "downloading", attempts: 2 });
    expect(req.nzbFile!.indexerGuid).toBe("de2");
  });

  it("does not mark broken when ffprobe has no or only 'und' language tags", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const untagged = await germanCheck([]);
    const und = await germanCheck(["und"]);
    await createRequest(a.id, { status: "done", nzbFileId: untagged.id });
    await createRequest(b.id, { status: "done", nzbFileId: und.id });

    await syncMovieRequests();

    expect((await prisma.movieRequest.findMany()).map((r) => r.status)).toEqual(["done", "done"]);
    const files = await prisma.nzbFile.findMany({ where: { id: { in: [untagged.id, und.id] } } });
    expect(files.map((f) => f.status)).not.toContain("broken");
  });

  it("does not re-check a version the user deliberately loaded without German", async () => {
    const u = await createUser();
    const file = await germanCheck(["eng"]);
    await createRequest(u.id, { status: "done", allowedGroup: "foreign", germanOnly: false, nzbFileId: file.id });

    await syncMovieRequests();

    expect((await prisma.movieRequest.findFirstOrThrow()).status).toBe("done");
    expect((await prisma.nzbFile.findUniqueOrThrow({ where: { id: file.id } })).status).not.toBe("broken");
  });

  it("does not retry a manual pick after failure", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    const u = await createUser();
    const failed = await failedDownload(u.id);
    await createRequest(u.id, { nzbFileId: failed.id, manual: true });

    await syncMovieRequests();

    expect(mockDownload).not.toHaveBeenCalled();
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "failed", failReason: "download_failed" });
  });

  it("gives up after 3 attempts", async () => {
    mockSearch.mockResolvedValue([DE1, DE2]);
    const u = await createUser();
    const failed = await failedDownload(u.id);
    await createRequest(u.id, { nzbFileId: failed.id, attempts: 3, triedKeys: ["guid:de1", "guid:x", "guid:y"] });

    await syncMovieRequests();

    expect(mockDownload).not.toHaveBeenCalled();
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("leaves a request for the next run when the indexer is unavailable and keeps going", async () => {
    mockSearch.mockRejectedValueOnce(new IndexerError("http", 500)).mockResolvedValue([DE1, DE2]);
    const [a, b] = [await createUser(), await createUser()];
    const failed = await failedDownload(a.id);
    const first = await createRequest(a.id, { nzbFileId: failed.id }, 30);
    const second = await createRequest(b.id, { nzbFileId: null }, 20);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncMovieRequests();

    expect(await prisma.movieRequest.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);
    expect(await prisma.movieRequest.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ attempts: 2 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a rejected file out of the library when its retry is deferred", async () => {
    mockSearch.mockRejectedValue(new IndexerError("http", 500));
    const u = await createUser();
    const file = await germanCheck(["eng"]);
    await prisma.userLibrary.create({ data: { userId: u.id, nzbFileId: file.id } });
    await createRequest(u.id, { status: "done", nzbFileId: file.id });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const removedAt = async () => (await prisma.userLibrary.findFirstOrThrow({ where: { nzbFileId: file.id } })).removedAt;
    await syncMovieRequests();
    const firstRemoval = await removedAt();
    await syncMovieRequests();

    expect(firstRemoval).not.toBeNull();
    expect(await removedAt()).toEqual(firstRemoval);
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "downloading", attempts: 1 });
    warn.mockRestore();
  });

  it("never falls back to an English version after a confirmed German cam failed", async () => {
    mockSearch.mockResolvedValue([CAM_DE, EN]);
    const u = await createUser();
    const failed = await failedDownload(u.id, "decam");
    await createRequest(u.id, { allowedGroup: "cam", triedKeys: ["guid:decam"], nzbFileId: failed.id });

    await syncMovieRequests();

    expect(mockDownload).not.toHaveBeenCalled();
    expect(await prisma.movieRequest.findFirstOrThrow()).toMatchObject({ status: "failed", failReason: "no_candidate" });
  });

  it("re-checks the audio of a German cam and retries when ffprobe finds no German", async () => {
    mockSearch.mockResolvedValue([CAM_DE, DE2]);
    const u = await createUser();
    const file = await germanCheck(["eng"], "decam");
    await createRequest(u.id, { status: "done", allowedGroup: "cam", triedKeys: ["guid:decam"], nzbFileId: file.id });

    await syncMovieRequests();

    expect((await prisma.nzbFile.findUniqueOrThrow({ where: { id: file.id } })).status).toBe("broken");
    expect(mockDownload.mock.calls.map((c) => c[0])).toEqual(["de2"]);
  });
});
