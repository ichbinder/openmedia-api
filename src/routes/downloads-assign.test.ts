import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

// Mock TMDB — the assign flow hits searchTmdbMovieById with the user-picked
// tmdbId. Default response is "found" so most tests just work; individual
// tests override with mockResolvedValueOnce for not_found/error/disabled.
vi.mock("../lib/tmdb.js", () => ({
  searchTmdbMovie: vi.fn().mockResolvedValue({
    status: "found",
    movie: {
      tmdbId: 888_001,
      imdbId: "tt8880001",
      titleDe: "Seed Movie",
      titleEn: "Seed Movie",
      description: "Used by setup to create initial needs_review NzbFiles via the request path.",
      year: 2024,
      posterPath: "/seed.jpg",
    },
  }),
  searchTmdbMovieById: vi.fn().mockResolvedValue({
    status: "found",
    movie: {
      tmdbId: 603,
      imdbId: "tt0133093",
      titleDe: "Matrix",
      titleEn: "The Matrix",
      description: "Ein Hacker entdeckt die Wahrheit über seine Realität.",
      year: 1999,
      posterPath: "/matrix.jpg",
    },
  }),
}));

const app = createApp();

// Minimal valid NZB XML
const NZB_A = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="a@x.com" date="1" subject="Assign.Test.A.2024.1080p [1/1] &quot;a.rar&quot; yEnc">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100" number="1">assign-a@test.com</segment></segments>
  </file>
</nzb>`;

const NZB_B = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="b@x.com" date="2" subject="Assign.Test.B.2024.720p [1/1] &quot;b.rar&quot; yEnc">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100" number="1">assign-b@test.com</segment></segments>
  </file>
</nzb>`;

let emailCounter = 0;
async function registerUser() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `assign-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "Assign User" });
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

/**
 * Create a needs_review DownloadJob by uploading an NZB with the TMDB
 * searchTmdbMovie mocked to return not_found. Returns the job id.
 */
async function createNeedsReviewJob(token: string, nzb: string, title: string): Promise<string> {
  const tmdbModule = await import("../lib/tmdb.js");
  vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({ status: "not_found" });

  const res = await request(app)
    .post("/downloads/request")
    .set("Authorization", `Bearer ${token}`)
    .send({ nzbContent: nzb, title });

  expect(res.status).toBe(201);
  expect(res.body.needsReview).toBe(true);
  return res.body.job.id as string;
}

describe("POST /downloads/jobs/:id/assign-movie", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-install default mocks (clearAllMocks removes them). Awaited so the
    // mocks are in place before the test body runs — fire-and-forget .then()
    // raced in an earlier version.
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValue({
      status: "found",
      movie: {
        tmdbId: 888_001,
        imdbId: "tt8880001",
        titleDe: "Seed Movie",
        titleEn: "Seed Movie",
        description: "default",
        year: 2024,
        posterPath: "/seed.jpg",
      },
    });
    vi.mocked(tmdbModule.searchTmdbMovieById).mockResolvedValue({
      status: "found",
      movie: {
        tmdbId: 603,
        imdbId: "tt0133093",
        titleDe: "Matrix",
        titleEn: "The Matrix",
        description: "default",
        year: 1999,
        posterPath: "/matrix.jpg",
      },
    });
  });

  it("Happy Path — weist einem needs_review Job einen Film zu und flippt ihn auf queued", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "Assign Test A");

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAssigned).toBe(false);
    expect(res.body.flippedCount).toBe(1);
    expect(res.body.movie.tmdbId).toBe(603);
    expect(res.body.movie.titleEn).toBe("The Matrix");

    // DB side effects
    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: { include: { movie: true } } },
    });
    expect(job.status).toBe("queued");
    expect(job.error).toBeNull();
    expect(job.reviewExpiresAt).toBeNull();
    expect(job.tmdbRetryAfter).toBeNull();
    expect(job.nzbFile.movieId).not.toBeNull();
    expect(job.nzbFile.movie?.tmdbId).toBe(603);
    expect(job.nzbFile.movie?.titleEn).toBe("The Matrix");
  });

  it("verwendet einen bestehenden NzbMovie mit gleicher tmdbId wieder (kein Duplikat)", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "Assign Test A");

    // Pre-create the target NzbMovie
    const existingMovie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 603,
        imdbId: "tt0133093",
        titleDe: "Matrix",
        titleEn: "The Matrix",
        description: "existing",
        year: 1999,
        posterPath: "/matrix.jpg",
      },
    });

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(200);
    expect(res.body.movie.id).toBe(existingMovie.id);

    // Only one NzbMovie with tmdbId 603 exists
    const count = await prisma.nzbMovie.count({ where: { tmdbId: 603 } });
    expect(count).toBe(1);

    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: true },
    });
    expect(job.nzbFile.movieId).toBe(existingMovie.id);
  });

  it("lehnt ab wenn Caller nicht der Job-Owner ist (403)", async () => {
    const { token: tokenA } = await registerUser();
    const { token: tokenB } = await registerUser();

    const jobId = await createNeedsReviewJob(tokenA, NZB_A, "Owned by A");

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Uploader");

    // Job untouched
    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: true },
    });
    expect(job.status).toBe("needs_review");
    expect(job.nzbFile.movieId).toBeNull();
  });

  it("lehnt ab wenn Job nicht im needs_review Status ist (409)", async () => {
    const { token } = await registerUser();

    // Create a normal queued job (default mock returns found)
    const res1 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: NZB_B, title: "Normal Upload" });
    expect(res1.status).toBe(201);
    expect(res1.body.job.status).toBe("queued");

    const res = await request(app)
      .post(`/downloads/jobs/${res1.body.job.id}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("needs_review");
    expect(res.body.currentStatus).toBe("queued");
  });

  it("lehnt ab wenn Job nicht existiert (404)", async () => {
    const { token } = await registerUser();

    const res = await request(app)
      .post(`/downloads/jobs/00000000-0000-0000-0000-000000000000/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(404);
  });

  it("lehnt ab wenn tmdbId ungültig ist (400)", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "Invalid tmdbId");

    // Missing body
    const res1 = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res1.status).toBe(400);

    // Wrong type
    const res2 = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: "603" });
    expect(res2.status).toBe(400);

    // Negative
    const res3 = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: -1 });
    expect(res3.status).toBe(400);
  });

  it("antwortet mit 404 wenn TMDB die tmdbId nicht findet", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "Invalid TMDB ID");

    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovieById).mockResolvedValueOnce({ status: "not_found" });

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 99999999 });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("TMDB");
    expect(res.body.tmdbId).toBe(99999999);

    // Job untouched
    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: true },
    });
    expect(job.status).toBe("needs_review");
    expect(job.nzbFile.movieId).toBeNull();
  });

  it("antwortet mit 503 wenn TMDB einen transienten Fehler wirft", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "TMDB error");

    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovieById).mockResolvedValueOnce({
      status: "error",
      reason: "TMDB rate limit exceeded",
    });

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(503);

    // Job untouched — the user can retry once TMDB recovers
    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: true },
    });
    expect(job.status).toBe("needs_review");
    expect(job.nzbFile.movieId).toBeNull();
  });

  it("antwortet mit 503 wenn TMDB komplett deaktiviert ist", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "TMDB disabled");

    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovieById).mockResolvedValueOnce({
      status: "disabled",
      reason: "TMDB_API_KEY is not configured",
    });

    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("tmdb_disabled");
  });

  it("flippt ALLE needs_review Jobs auf der gleichen NzbFile (Multi-Job Flip)", async () => {
    const { token: tokenA } = await registerUser();
    const { token: tokenB } = await registerUser();

    // User A uploads — creates needs_review job 1
    const jobIdA = await createNeedsReviewJob(tokenA, NZB_A, "Shared Hash Assign");

    // User B uploads SAME hash — should reuse the NzbFile and create a second
    // needs_review job.
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({ status: "not_found" });
    const resB = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ nzbContent: NZB_A, title: "Shared Hash Assign" });
    expect(resB.status).toBe(201);
    expect(resB.body.needsReview).toBe(true);
    expect(resB.body.reused).toBe(true);
    const jobIdB = resB.body.job.id as string;

    // Both jobs share the same NzbFile
    const jobA = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobIdA } });
    const jobB = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobIdB } });
    expect(jobA.nzbFileId).toBe(jobB.nzbFileId);

    // User A assigns
    const res = await request(app)
      .post(`/downloads/jobs/${jobIdA}/assign-movie`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAssigned).toBe(false);
    expect(res.body.flippedCount).toBe(2); // Both jobs flipped

    // Both jobs now queued
    const finalA = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobIdA } });
    const finalB = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobIdB } });
    expect(finalA.status).toBe("queued");
    expect(finalB.status).toBe("queued");

    // NzbFile linked to the new movie
    const nzbFile = await prisma.nzbFile.findUniqueOrThrow({
      where: { id: jobA.nzbFileId },
      include: { movie: true },
    });
    expect(nzbFile.movieId).not.toBeNull();
    expect(nzbFile.movie?.tmdbId).toBe(603);
  });

  it("erkennt Race mit zwischenzeitlich zugeordneter NzbFile (alreadyAssigned)", async () => {
    const { token } = await registerUser();
    const jobId = await createNeedsReviewJob(token, NZB_A, "Race test");

    // Simulate another path (concurrent user, reconciler, etc.) assigning the
    // NzbFile BEFORE our assign-movie call reaches the transaction.
    const presetMovie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 999_777,
        titleDe: "Preset Movie",
        titleEn: "Preset Movie",
        year: 2020,
      },
    });

    const job = await prisma.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { nzbFile: true },
    });
    await prisma.nzbFile.update({
      where: { id: job.nzbFileId },
      data: { movieId: presetMovie.id },
    });

    // Now the user tries to assign a DIFFERENT tmdbId (603). The endpoint
    // should respect the preset assignment and flip only this user's job.
    const res = await request(app)
      .post(`/downloads/jobs/${jobId}/assign-movie`)
      .set("Authorization", `Bearer ${token}`)
      .send({ tmdbId: 603 });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAssigned).toBe(true);
    expect(res.body.flippedCount).toBe(1);
    // The response reflects the PRESET movie, not the tmdbId the user sent
    expect(res.body.movie.id).toBe(presetMovie.id);
    expect(res.body.movie.tmdbId).toBe(999_777);

    // NzbFile still linked to the preset movie (not overwritten by 603)
    const nzbFile = await prisma.nzbFile.findUniqueOrThrow({
      where: { id: job.nzbFileId },
    });
    expect(nzbFile.movieId).toBe(presetMovie.id);

    // Job flipped to queued
    const finalJob = await prisma.downloadJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(finalJob.status).toBe("queued");
  });
});
