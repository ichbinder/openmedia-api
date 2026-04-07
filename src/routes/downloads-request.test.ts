import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

// Mock the S3 module for the alreadyAvailable tests
vi.mock("../lib/s3.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return {
    ...original,
    fileExists: vi.fn().mockResolvedValue(true),
  };
});

// Mock TMDB — default to a generic "found" result so existing tests get a normal
// queued job. Tests that need needs_review can override the mock with not_found
// or error per-test using vi.mocked(...).mockResolvedValueOnce(...).
vi.mock("../lib/tmdb.js", () => ({
  searchTmdbMovie: vi.fn().mockResolvedValue({
    status: "found",
    movie: {
      tmdbId: 999_001,
      imdbId: "tt9990001",
      titleDe: "Test Movie 2024",
      titleEn: "Test Movie 2024",
      description: "Default mock movie for tests.",
      year: 2024,
      posterPath: "/test-poster.jpg",
    },
  }),
}));

const app = createApp();

// Minimal valid NZB XML for testing
const VALID_NZB = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="test@test.com" date="1234567890" subject="Test.Movie.2024.1080p.BluRay.x264-GROUP [1/1] &quot;test.rar&quot; yEnc (1/10)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="100000" number="1">abc123@test.com</segment></segments>
  </file>
</nzb>`;

// Different content → different hash
const VALID_NZB_2 = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="other@test.com" date="9999999999" subject="Another.Film.2023.720p [1/1] &quot;other.rar&quot; yEnc (1/5)">
    <groups><group>alt.binaries.movies</group></groups>
    <segments><segment bytes="50000" number="1">def456@test.com</segment></segments>
  </file>
</nzb>`;

let emailCounter = 0;
async function getAuthToken() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `upload-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "Upload User" });
  return res.body.token as string;
}

describe("POST /downloads/request", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  it("akzeptiert gültigen NZB-Upload und erstellt Job", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: VALID_NZB,
        title: "Test Movie 2024",
      });

    expect(res.status).toBe(201);
    expect(res.body.job).toBeDefined();
    expect(res.body.job.status).toBe("queued");
    expect(res.body.job.nzbFile).toBeDefined();
    expect(res.body.job.nzbFile.movie).toBeDefined();
    expect(res.body.job.nzbFile.movie.titleEn).toBe("Test Movie 2024");
    expect(res.body.reused).toBe(false);
  });

  it("parst Metadaten aus dem Filename", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: VALID_NZB,
        title: "Matrix Reloaded",
        filename: "Matrix.Reloaded.2003.1080p.BluRay.x264-GROUP.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.job.nzbFile.resolution).toBe("1080p");
  });

  it("lehnt fehlenden nzbContent ab", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Test" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("nzbContent");
  });

  it("lehnt fehlenden title ab", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("title");
  });

  it("lehnt zu kurzen nzbContent ab", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: "<nzb/>", title: "Short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("zu kurz");
  });

  it("lehnt ungültiges XML ab", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: "This is just plain text, not XML at all, and it is definitely longer than fifty characters for sure.",
        title: "Not XML",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("NZB-XML");
  });

  it("dedupliziert anhand des Hashes — gleicher Content ergibt keinen neuen NzbFile", async () => {
    // First upload
    const res1 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB_2, title: "First Upload" });

    expect(res1.status).toBe(201);
    expect(res1.body.reused).toBe(false);
    const firstJobId = res1.body.job.id;

    // Mark first job as completed so a new one can be created
    await prisma.downloadJob.update({
      where: { id: firstJobId },
      data: { status: "completed", completedAt: new Date() },
    });

    // Second upload — same content
    const res2 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB_2, title: "Second Upload" });

    expect(res2.status).toBe(201);
    expect(res2.body.reused).toBe(true);
    // Same NzbFile, different Job
    expect(res2.body.job.nzbFile.id).toBe(res1.body.job.nzbFile.id);
    expect(res2.body.job.id).not.toBe(firstJobId);
  });

  it("gibt 409 wenn aktiver Download für gleiche NZB läuft", async () => {
    // First upload — job stays queued
    const res1 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB, title: "Active Job Test" });

    expect(res1.status).toBe(201);

    // Second upload — same content, job still active
    const res2 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB, title: "Active Job Test" });

    expect(res2.status).toBe(409);
    expect(res2.body.existingJobId).toBe(res1.body.job.id);
    expect(res2.body.existingStatus).toBe("queued");
  });

  it("lehnt unautorisierte Requests ab", async () => {
    const res = await request(app)
      .post("/downloads/request")
      .send({ nzbContent: VALID_NZB, title: "No Auth" });

    expect(res.status).toBe(401);
  });

  it("gibt alreadyAvailable zurück wenn Film schon auf S3 liegt", async () => {
    // Create NzbFile with s3Key directly in DB (simulates completed download)
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Matrix", titleEn: "The Matrix", year: 1999 },
    });

    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(VALID_NZB).digest("hex");

    await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash,
        originalFilename: "matrix.nzb",
        s3Key: `${hash}/${hash}.mkv`,
        s3StreamKey: `${hash}/${hash}.mp4`,
        s3Bucket: "openmedia-files",
        fileExtension: ".mkv",
        downloadedAt: new Date(),
      },
    });

    // fileExists is mocked to return true
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB, title: "The Matrix" });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAvailable).toBe(true);
    expect(res.body.message).toContain("bereits");
    expect(res.body.movie.titleEn).toBe("The Matrix");
    expect(res.body.nzbFile.s3Key).toContain(hash);
  });

  it("startet Download wenn s3Key gesetzt aber Datei weg (S3 mock returns false)", async () => {
    // Override the mock for this specific test
    const s3Module = await import("../lib/s3.js");
    vi.mocked(s3Module.fileExists).mockResolvedValueOnce(false);

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Gone Film", titleEn: "Gone Film", year: 2020 },
    });

    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(VALID_NZB_2).digest("hex");

    await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash,
        originalFilename: "gone.nzb",
        s3Key: `${hash}/${hash}.mkv`,
        s3Bucket: "openmedia-files",
        downloadedAt: new Date(),
      },
    });

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB_2, title: "Gone Film" });

    // Should create a new download job (file was "gone" from S3)
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(true);
    expect(res.body.job.status).toBe("queued");

    // Verify DB was cleaned up (s3Key reset)
    const updatedFile = await prisma.nzbFile.findUnique({ where: { hash } });
    expect(updatedFile?.s3Key).toBeNull();
    expect(updatedFile?.downloadedAt).toBeNull();
  });

  // --- TMDB Matching ---

  it("verknüpft NzbMovie mit TMDB-Daten bei erfolgreichem Match", async () => {
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({
      status: "found",
      movie: {
        tmdbId: 773,
        imdbId: "tt0449059",
        titleDe: "Little Miss Sunshine",
        titleEn: "Little Miss Sunshine",
        description: "Eine dysfunktionale Familie...",
        year: 2006,
        posterPath: "/wKn7AJw730emlmzLSmJtzquwaeW.jpg",
      },
    });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="Little.Miss.Sunshine.2006.1080p.BluRay.x264 [1/1] &quot;a.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">a@b.com</segment></segments></file></nzb>`;

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Little Miss Sunshine 2006",
        filename: "Little.Miss.Sunshine.2006.1080p.BluRay.x264.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.job.nzbFile.movie.tmdbId).toBe(773);
    expect(res.body.job.nzbFile.movie.titleEn).toBe("Little Miss Sunshine");
    expect(res.body.job.nzbFile.movie.year).toBe(2006);
    expect(res.body.job.nzbFile.movie.posterPath).toContain("wKn7AJw730emlmzLSmJtzquwaeW");
  });

  it("verwendet bestehenden NzbMovie mit gleicher tmdbId wieder", async () => {
    // Pre-create a movie with tmdbId 773
    const existingMovie = await prisma.nzbMovie.create({
      data: {
        tmdbId: 773,
        titleDe: "Little Miss Sunshine",
        titleEn: "Little Miss Sunshine",
        year: 2006,
      },
    });

    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({
      status: "found",
      movie: {
        tmdbId: 773,
        imdbId: "tt0449059",
        titleDe: "Little Miss Sunshine",
        titleEn: "Little Miss Sunshine",
        description: "...",
        year: 2006,
        posterPath: "/poster.jpg",
      },
    });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="LMS.2006 [1/1] &quot;different.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">unique@b.com</segment></segments></file></nzb>`;

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Little Miss Sunshine",
        filename: "Little.Miss.Sunshine.2006.720p.WEB.x264.nzb",
      });

    expect(res.status).toBe(201);
    // Same movie ID, not a new one
    expect(res.body.job.nzbFile.movie.id).toBe(existingMovie.id);

    // Verify only ONE movie exists with tmdbId 773
    const count = await prisma.nzbMovie.count({ where: { tmdbId: 773 } });
    expect(count).toBe(1);
  });

  // --- Broken NZB Rejection ---

  it("lehnt broken NzbFile mit 410 Gone ab", async () => {
    // Pre-create a broken NzbFile
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Broken Film", titleEn: "Broken Film", year: 2020 },
    });

    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(VALID_NZB).digest("hex");

    await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash,
        originalFilename: "broken.nzb",
        status: "broken",
        brokenReason: "Download 5x fehlgeschlagen: missing articles",
        failedAttempts: 5,
      },
    });

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB, title: "Broken Film" });

    expect(res.status).toBe(410);
    expect(res.body.error).toContain("kaputt");
    expect(res.body.failedAttempts).toBe(5);
    expect(res.body.reason).toContain("missing articles");
    expect(res.body.movie.titleEn).toBe("Broken Film");
    expect(res.body.hint).toContain("andere NZB-Version");
  });

  it("lehnt broken NzbFile NICHT ab wenn Film auf S3 verfügbar ist", async () => {
    // Pre-create a broken NzbFile that is also on S3 (rare but possible)
    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Broken But Available", titleEn: "Broken But Available", year: 2021 },
    });

    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(VALID_NZB_2).digest("hex");

    await prisma.nzbFile.create({
      data: {
        movieId: movie.id,
        hash,
        originalFilename: "broken-but-on-s3.nzb",
        status: "broken",
        brokenReason: "Old failure history",
        failedAttempts: 5,
        s3Key: `${hash}/${hash}.mkv`,
        s3Bucket: "openmedia-files",
        downloadedAt: new Date(),
      },
    });

    // fileExists is mocked to return true (default mock)
    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: VALID_NZB_2, title: "Broken But Available" });

    expect(res.status).toBe(200);
    expect(res.body.alreadyAvailable).toBe(true);
  });

  // --- needs_review path (TMDB no match / error) ---

  it("erstellt needs_review Job wenn TMDB nichts findet (kein Phantom-Movie)", async () => {
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({ status: "not_found" });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="Xyzzy.Random.String [1/1] &quot;u.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">xyzzy@b.com</segment></segments></file></nzb>`;

    // Snapshot the movie count so we can assert nothing was created,
    // regardless of whether the phantom title would have been "Xyzzy..."
    // or something else derived from the parsed filename.
    const movieCountBefore = await prisma.nzbMovie.count();

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Xyzzy Random String 2099",
        filename: "Xyzzy.Random.String.2099.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.needsReview).toBe(true);
    expect(res.body.job.status).toBe("needs_review");
    expect(res.body.job.reviewExpiresAt).toBeDefined();
    expect(new Date(res.body.job.reviewExpiresAt).getTime()).toBeGreaterThan(Date.now());
    // No movie should be linked
    expect(res.body.job.nzbFile.movie).toBeNull();
    expect(res.body.job.nzbFile.movieId).toBeNull();

    // Robust phantom-movie assertion: the total NzbMovie count must not have
    // changed at all. Narrow title-based lookups would miss phantoms whose
    // title was derived from the parsed filename rather than the user-supplied
    // title field.
    const movieCountAfter = await prisma.nzbMovie.count();
    expect(movieCountAfter).toBe(movieCountBefore);
  });

  it("erstellt needs_review Job mit tmdbRetryAfter bei TMDB-Error", async () => {
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({
      status: "error",
      reason: "TMDB rate limit exceeded",
    });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="Rate.Limited.Movie [1/1] &quot;u.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">rl@b.com</segment></segments></file></nzb>`;

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Rate Limited Movie",
        filename: "Rate.Limited.Movie.2024.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.needsReview).toBe(true);
    expect(res.body.job.status).toBe("needs_review");
    // Background retry must be scheduled for transient errors
    expect(res.body.job.tmdbRetryAfter).toBeDefined();
    expect(new Date(res.body.job.tmdbRetryAfter).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.job.nzbFile.movieId).toBeNull();
  });

  it("erstellt KEINEN tmdbRetryAfter bei not_found (definitive Antwort)", async () => {
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({ status: "not_found" });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="Definitive.NotFound [1/1] &quot;u.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">def@b.com</segment></segments></file></nzb>`;

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Definitive Not Found",
        filename: "Definitive.NotFound.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.needsReview).toBe(true);
    expect(res.body.job.tmdbRetryAfter).toBeNull();
  });

  it("propagiert needs_review beim Reuse einer existierenden movieId=null NzbFile", async () => {
    // First upload — TMDB not found, creates needs_review NzbFile
    const tmdbModule = await import("../lib/tmdb.js");
    vi.mocked(tmdbModule.searchTmdbMovie).mockResolvedValueOnce({ status: "not_found" });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="shared@x.com" date="1" subject="Shared.Hash.Test [1/1] &quot;s.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">shared@b.com</segment></segments></file></nzb>`;

    const res1 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: NZB, title: "Shared Hash Test" });

    expect(res1.status).toBe(201);
    expect(res1.body.needsReview).toBe(true);

    // Second upload — different user, same hash. The reuse path should also
    // produce a needs_review job, not a queued one.
    const token2 = await getAuthToken();
    const res2 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token2}`)
      .send({ nzbContent: NZB, title: "Shared Hash Test" });

    expect(res2.status).toBe(201);
    expect(res2.body.reused).toBe(true);
    expect(res2.body.needsReview).toBe(true);
    expect(res2.body.job.status).toBe("needs_review");
    // Both jobs share the same NzbFile
    expect(res2.body.job.nzbFile.id).toBe(res1.body.job.nzbFile.id);
    // But are distinct DownloadJob rows
    expect(res2.body.job.id).not.toBe(res1.body.job.id);
  });

  it("verhindert doppelte needs_review Jobs für denselben User+Hash", async () => {
    const tmdbModule = await import("../lib/tmdb.js");
    // Use mockResolvedValueOnce twice so the mock self-resets after this test,
    // even if an earlier assertion throws. This keeps the default "found" mock
    // intact for subsequent tests.
    vi.mocked(tmdbModule.searchTmdbMovie)
      .mockResolvedValueOnce({ status: "not_found" })
      .mockResolvedValueOnce({ status: "not_found" });

    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="dup@x.com" date="1" subject="Duplicate.Review.Test [1/1] &quot;d.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">dup@b.com</segment></segments></file></nzb>`;

    const res1 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: NZB, title: "Duplicate Review Test" });

    expect(res1.status).toBe(201);
    expect(res1.body.needsReview).toBe(true);

    // Same user uploads the same hash again — should get 409 with the existing job
    const res2 = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: NZB, title: "Duplicate Review Test" });

    expect(res2.status).toBe(409);
    expect(res2.body.existingJobId).toBe(res1.body.job.id);
    expect(res2.body.existingStatus).toBe("needs_review");
  });
});
