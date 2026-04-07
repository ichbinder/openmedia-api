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

// Mock TMDB — default to "not_found" so fallback path is exercised by existing tests
vi.mock("../lib/tmdb.js", () => ({
  searchTmdbMovie: vi.fn().mockResolvedValue({ status: "not_found" }),
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

  it("nutzt Fallback wenn TMDB nichts findet", async () => {
    // Default mock already returns not_found
    const NZB = `<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="x@x.com" date="1" subject="Unknown.Movie [1/1] &quot;u.rar&quot; yEnc"><groups><group>g</group></groups><segments><segment bytes="1" number="1">unknown@b.com</segment></segments></file></nzb>`;

    const res = await request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({
        nzbContent: NZB,
        title: "Unknown Movie 2099",
        filename: "Unknown.Movie.2099.nzb",
      });

    expect(res.status).toBe(201);
    expect(res.body.job.nzbFile.movie.tmdbId).toBeNull();
    expect(res.body.job.nzbFile.movie.titleEn).toBe("Unknown Movie 2099");
  });
});
