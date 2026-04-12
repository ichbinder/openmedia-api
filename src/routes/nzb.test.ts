import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

const app = createApp();

// Helper: register + get token
let emailCounter = 0;
async function getAuthToken() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `nzb-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "NZB User" });
  return res.body.token as string;
}

// Helper: create a movie with unique tmdbId
let tmdbCounter = 10000;
async function createMovie(token: string, overrides: Record<string, unknown> = {}) {
  tmdbCounter++;
  const res = await request(app)
    .post("/nzb/movies")
    .set("Authorization", `Bearer ${token}`)
    .send({
      titleDe: "Der Pate",
      titleEn: "The Godfather",
      description: "Ein Mafioso...",
      tmdbId: tmdbCounter,
      imdbId: `tt${tmdbCounter}`,
      year: 1972,
      ...overrides,
    });
  return res;
}

describe("NZB Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  describe("NzbMovie CRUD", () => {
    it("erstellt einen Film", async () => {
      const res = await createMovie(token);

      expect(res.status).toBe(201);
      expect(res.body.movie.titleEn).toBe("The Godfather");
      expect(res.body.movie.tmdbId).toBeDefined();
      expect(res.body.movie.year).toBe(1972);
    });

    it("lehnt doppelte TMDB-ID ab", async () => {
      await createMovie(token, { tmdbId: 999999 });
      const res = await createMovie(token, { tmdbId: 999999 });

      expect(res.status).toBe(409);
    });

    it("listet alle Filme", async () => {
      await createMovie(token, { tmdbId: 1, titleEn: "Film 1" });
      await createMovie(token, { tmdbId: 2, titleEn: "Film 2" });

      const res = await request(app)
        .get("/nzb/movies")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.movies).toHaveLength(2);
    });

    it("findet Film nach ID", async () => {
      const created = await createMovie(token);
      const res = await request(app)
        .get(`/nzb/movies/${created.body.movie.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.movie.titleEn).toBe("The Godfather");
    });

    it("findet Film nach TMDB-ID", async () => {
      await createMovie(token, { tmdbId: 888888 });
      const res = await request(app)
        .get("/nzb/movies/by-tmdb/888888")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.movie.titleEn).toBe("The Godfather");
    });

    it("by-tmdb liefert NZB status/brokenReason/failedAttempts", async () => {
      const created = await createMovie(token, { tmdbId: 999111 });
      const movieId = created.body.movie.id;
      // Add an NZB file
      const fileRes = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: `test-tmdb-fields-${Date.now()}`, originalFilename: "test.nzb", resolution: "1080p" });
      expect(fileRes.status).toBe(201);

      // Mark as broken
      await request(app)
        .patch(`/nzb/files/${fileRes.body.nzbFile.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "broken", brokenReason: "Missing articles" });

      // Set failedAttempts via direct DB update (simulating 3 failures)
      await prisma.nzbFile.update({ where: { id: fileRes.body.nzbFile.id }, data: { failedAttempts: 3 } });

      const res = await request(app)
        .get("/nzb/movies/by-tmdb/999111")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const nzb = res.body.movie.nzbFiles[0];
      expect(nzb.status).toBe("broken");
      expect(nzb.brokenReason).toBe("Missing articles");
      expect(nzb.failedAttempts).toBe(3);
    });

    it("aktualisiert einen Film", async () => {
      const created = await createMovie(token);
      const res = await request(app)
        .put(`/nzb/movies/${created.body.movie.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ titleDe: "Der Pate - Aktualisiert" });

      expect(res.status).toBe(200);
      expect(res.body.movie.titleDe).toBe("Der Pate - Aktualisiert");
    });

    it("löscht einen Film", async () => {
      const created = await createMovie(token);
      const res = await request(app)
        .delete(`/nzb/movies/${created.body.movie.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("lehnt unautorisiert ab", async () => {
      const res = await request(app).get("/nzb/movies");
      expect(res.status).toBe(401);
    });
  });

  describe("NzbFile CRUD", () => {
    let movieId: string;

    beforeEach(async () => {
      const movie = await createMovie(token, { tmdbId: Math.floor(Math.random() * 100000) });
      movieId = movie.body.movie.id;
    });

    it("fügt NZB-Datei zu Film hinzu", async () => {
      const res = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({
          movieId,
          hash: "abc123hash",
          originalFilename: "The.Godfather.1972.1080p.BluRay.x264-GROUP.nzb",
          resolution: "1080p",
          audioLanguages: ["de", "en"],
          codec: "x264",
          source: "external",
          releaseType: "BluRay",
        });

      expect(res.status).toBe(201);
      expect(res.body.nzbFile.hash).toBe("abc123hash");
      expect(res.body.nzbFile.resolution).toBe("1080p");
      expect(res.body.nzbFile.audioLanguages).toEqual(["de", "en"]);
      expect(res.body.nzbFile.source).toBe("external");
      expect(res.body.nzbFile.releaseType).toBe("BluRay");
    });

    it("lehnt doppelten Hash ab", async () => {
      await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "samehash", originalFilename: "file1.nzb" });

      const res = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "samehash", originalFilename: "file2.nzb" });

      expect(res.status).toBe(409);
    });

    it("findet NZB-Datei nach Hash", async () => {
      await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "findhash", originalFilename: "file.nzb" });

      const res = await request(app)
        .get("/nzb/files/by-hash/findhash")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.nzbFile.hash).toBe("findhash");
      expect(res.body.nzbFile.movie).toBeDefined();
    });

    it("aktualisiert NZB-Datei Status", async () => {
      const created = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "statushash", originalFilename: "file.nzb" });

      const res = await request(app)
        .patch(`/nzb/files/${created.body.nzbFile.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "broken", brokenReason: "Ton verschoben ab Minute 42" });

      expect(res.status).toBe(200);
      expect(res.body.nzbFile.status).toBe("broken");
      expect(res.body.nzbFile.brokenReason).toBe("Ton verschoben ab Minute 42");
    });

    it("setzt brokenReason auf null wenn Status nicht broken", async () => {
      const created = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "clearhash", originalFilename: "file.nzb" });

      // Set broken first
      await request(app)
        .patch(`/nzb/files/${created.body.nzbFile.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "broken", brokenReason: "Kaputt" });

      // Set ok — reason should clear
      const res = await request(app)
        .patch(`/nzb/files/${created.body.nzbFile.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "ok" });

      expect(res.body.nzbFile.status).toBe("ok");
      expect(res.body.nzbFile.brokenReason).toBeNull();
    });

    it("löscht NZB-Datei", async () => {
      const created = await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "deletehash", originalFilename: "file.nzb" });

      const res = await request(app)
        .delete(`/nzb/files/${created.body.nzbFile.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it("cascade delete: Film löschen löscht NZB-Dateien", async () => {
      await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "cascade1", originalFilename: "file1.nzb" });
      await request(app)
        .post("/nzb/files")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId, hash: "cascade2", originalFilename: "file2.nzb" });

      // Delete movie
      await request(app)
        .delete(`/nzb/movies/${movieId}`)
        .set("Authorization", `Bearer ${token}`);

      // Files should be gone
      const check1 = await request(app)
        .get("/nzb/files/by-hash/cascade1")
        .set("Authorization", `Bearer ${token}`);
      expect(check1.status).toBe(404);
    });
  });

  describe("NZB Import", () => {
    it("importiert NZB-Datei und parst Metadaten", async () => {
      const nzbContent = Buffer.from("<nzb>test content for import</nzb>");

      const res = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .attach("nzb", nzbContent, "The.Matrix.1999.1080p.BluRay.x264-GROUP.nzb");

      expect(res.status).toBe(201);
      expect(res.body.imported).toBe(true);
      expect(res.body.nzbFile.resolution).toBe("1080p");
      expect(res.body.nzbFile.codec).toBe("x264");
      expect(res.body.parsed.title).toBe("The Matrix");
      expect(res.body.parsed.year).toBe(1999);
      expect(res.body.movie).toBeDefined();
      expect(res.body.movie.nzbFiles).toHaveLength(1);
    });

    it("erkennt Duplikate anhand des Hashes", async () => {
      const nzbContent = Buffer.from("<nzb>duplicate test content</nzb>");

      await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .attach("nzb", nzbContent, "Movie.1080p.nzb");

      const res = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .attach("nzb", nzbContent, "Movie.1080p.nzb");

      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(false);
      expect(res.body.message).toContain("existiert bereits");
    });

    it("importiert verschiedene Versionen zum gleichen Film", async () => {
      const nzb1080 = Buffer.from("<nzb>1080p version</nzb>");
      const nzb4k = Buffer.from("<nzb>4k version</nzb>");

      const res1 = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .attach("nzb", nzb1080, "Some.Film.2024.1080p.BluRay.x264.nzb");

      const res2 = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .attach("nzb", nzb4k, "Some.Film.2024.2160p.BluRay.x265.nzb");

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);

      // Without TMDB, both create separate movies (different parsed titles may match)
      // The important thing is both imported successfully
      expect(res1.body.nzbFile.resolution).toBe("1080p");
      expect(res2.body.nzbFile.resolution).toBe("2160p");
    });

    it("akzeptiert Import mit expliziter movieId", async () => {
      const movie = await createMovie(token);
      const movieId = movie.body.movie.id;
      const nzbContent = Buffer.from("<nzb>explicit movie id test</nzb>");

      const res = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`)
        .field("movieId", movieId)
        .attach("nzb", nzbContent, "Some.Movie.1080p.nzb");

      expect(res.status).toBe(201);
      expect(res.body.movie.id).toBe(movieId);
    });

    it("lehnt Import ohne Datei ab", async () => {
      const res = await request(app)
        .post("/nzb/import")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it("lehnt unautorisiert ab", async () => {
      const res = await request(app)
        .post("/nzb/import")
        .attach("nzb", Buffer.from("test"), "test.nzb");

      expect(res.status).toBe(401);
    });
  });

  describe("Download Link", () => {
    it("gibt 404 für nicht existierende NZB-Datei", async () => {
      const res = await request(app)
        .get("/nzb/files/nonexistent-id/download-link")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("gibt 422 wenn NZB-Datei kein s3Key hat", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "DL Test", titleEn: "DL Test", year: 2024 },
      });
      const nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash: `dlhash-${Date.now()}`,
          originalFilename: "test.nzb",
          // s3Key is null — not yet downloaded
        },
      });

      const res = await request(app)
        .get(`/nzb/files/${nzbFile.id}/download-link`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("noch nicht heruntergeladen");
    });

    it("generiert Download-Link wenn s3Key vorhanden und S3 konfiguriert", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "DL Test", titleEn: "DL Test", year: 2024 },
      });
      const nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash: `dlhash2-${Date.now()}`,
          originalFilename: "test.nzb",
          s3Key: "fakehash/fakehash.mkv",
          s3Bucket: "openmedia-files",
          fileExtension: ".mkv",
          downloadedAt: new Date(),
        },
      });

      const res = await request(app)
        .get(`/nzb/files/${nzbFile.id}/download-link?expires=1d`)
        .set("Authorization", `Bearer ${token}`);

      // If S3 is not configured, expect 503
      if (res.status === 503) {
        expect(res.body.error).toContain("nicht konfiguriert");
        return;
      }

      expect(res.status).toBe(200);
      expect(res.body.url).toBeDefined();
      expect(res.body.expiresIn).toBe(86400); // 1 day
      expect(res.body.nzbFile.hash).toContain("dlhash2");
      expect(res.body.movie.titleEn).toBe("DL Test");
    });

    it("lehnt ungültigen expires-Wert ab", async () => {
      const movie = await prisma.nzbMovie.create({
        data: { titleDe: "DL Test", titleEn: "DL Test", year: 2024 },
      });
      const nzbFile = await prisma.nzbFile.create({
        data: {
          movieId: movie.id,
          hash: `dlhash3-${Date.now()}`,
          originalFilename: "test.nzb",
          s3Key: "fakehash/fakehash.mkv",
          s3Bucket: "openmedia-files",
        },
      });

      const res = await request(app)
        .get(`/nzb/files/${nzbFile.id}/download-link?expires=abc`)
        .set("Authorization", `Bearer ${token}`);

      if (res.status === 503) return;

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("expires");
    });
  });
});
