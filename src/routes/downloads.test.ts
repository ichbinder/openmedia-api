import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

const app = createApp();

// Helper
let emailCounter = 100;
async function getAuthToken() {
  emailCounter++;
  const res = await request(app)
    .post("/auth/register")
    .send({ email: `dl-${emailCounter}-${Date.now()}@test.de`, password: "test123", name: "DL User" });
  return res.body.token as string;
}

/** Create a test movie + NZB file for download job tests */
async function createTestNzbFile() {
  const movie = await prisma.nzbMovie.create({
    data: { titleDe: "Testfilm", titleEn: "Test Movie", year: 2024 },
  });
  const nzbFile = await prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash: `testhash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      originalFilename: "Test.Movie.2024.1080p.BluRay.x264.nzb",
      resolution: "1080p",
    },
  });
  return { movie, nzbFile };
}

describe("Downloads Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  // --- Legacy SABnzbd endpoints ---

  describe("GET /downloads/sabnzbd/config", () => {
    it("zeigt ob SABnzbd konfiguriert ist", async () => {
      const res = await request(app)
        .get("/downloads/sabnzbd/config")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("configured");
    });
  });

  describe("GET /downloads/sabnzbd/status", () => {
    it("gibt Status zurück (disconnected wenn nicht konfiguriert)", async () => {
      const res = await request(app)
        .get("/downloads/sabnzbd/status")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("connected");
    });
  });

  describe("POST /downloads/start", () => {
    it("lehnt fehlende nzbFileId ab", async () => {
      const res = await request(app)
        .post("/downloads/start")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it("lehnt nicht existierende nzbFileId ab", async () => {
      const res = await request(app)
        .post("/downloads/start")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: "nonexistent-id" });

      expect(res.status).toBe(404);
    });

    it("lehnt unautorisiert ab", async () => {
      const res = await request(app)
        .post("/downloads/start")
        .send({ nzbFileId: "test" });

      expect(res.status).toBe(401);
    });
  });

  // --- Download Job CRUD ---

  describe("POST /downloads/jobs", () => {
    it("erstellt einen Download-Job", async () => {
      const { nzbFile, movie } = await createTestNzbFile();

      const res = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      expect(res.status).toBe(201);
      expect(res.body.job.status).toBe("queued");
      expect(res.body.job.nzbFileId).toBe(nzbFile.id);
      expect(res.body.job.nzbFile.movie.titleEn).toBe("Test Movie");
    });

    it("lehnt fehlende nzbFileId ab", async () => {
      const res = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it("lehnt nicht existierende nzbFileId ab", async () => {
      const res = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: "nonexistent-id" });

      expect(res.status).toBe(404);
    });

    it("verhindert doppelte aktive Jobs für gleiche Datei", async () => {
      const { nzbFile } = await createTestNzbFile();

      // First job
      const res1 = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      expect(res1.status).toBe(201);

      // Second job — should be rejected
      const res2 = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      expect(res2.status).toBe(409);
      expect(res2.body.existingJobId).toBe(res1.body.job.id);
    });
  });

  describe("GET /downloads/jobs", () => {
    it("listet Download-Jobs", async () => {
      const { nzbFile } = await createTestNzbFile();
      await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      const res = await request(app)
        .get("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.jobs.length).toBeGreaterThanOrEqual(1);
    });

    it("filtert nach Status", async () => {
      const res = await request(app)
        .get("/downloads/jobs?status=completed")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.jobs).toEqual([]);
    });

    it("lehnt ungültigen Status-Filter ab", async () => {
      const res = await request(app)
        .get("/downloads/jobs?status=invalid")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });

  describe("GET /downloads/jobs/:id", () => {
    it("gibt einzelnen Job zurück", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      const res = await request(app)
        .get(`/downloads/jobs/${createRes.body.job.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.job.id).toBe(createRes.body.job.id);
    });

    it("gibt 404 für nicht existierenden Job", async () => {
      const res = await request(app)
        .get("/downloads/jobs/nonexistent-id")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /downloads/jobs/:id/status", () => {
    it("aktualisiert Status (queued → provisioning)", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      const jobId = createRes.body.job.id;

      const res = await request(app)
        .patch(`/downloads/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "provisioning", hetznerServerId: 12345 });

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe("provisioning");
      expect(res.body.job.hetznerServerId).toBe(12345);
      expect(res.body.job.startedAt).toBeDefined();
    });

    it("durchläuft kompletten Status-Lifecycle", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      const jobId = createRes.body.job.id;

      // queued → provisioning
      await request(app)
        .patch(`/downloads/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "provisioning" });

      // provisioning → downloading
      await request(app)
        .patch(`/downloads/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "downloading", progress: 10 });

      // downloading → uploading
      await request(app)
        .patch(`/downloads/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "uploading", progress: 90 });

      // uploading → completed (with S3 reference)
      const completeRes = await request(app)
        .patch(`/downloads/jobs/${jobId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          status: "completed",
          s3Key: `${nzbFile.hash}/${nzbFile.hash}.mkv`,
          s3Bucket: "openmedia-files",
          fileExtension: ".mkv",
        });

      expect(completeRes.status).toBe(200);
      expect(completeRes.body.job.status).toBe("completed");
      expect(completeRes.body.job.progress).toBe(100);
      expect(completeRes.body.job.completedAt).toBeDefined();

      // Verify NzbFile got S3 reference
      const nzbFileUpdated = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(nzbFileUpdated!.s3Key).toBe(`${nzbFile.hash}/${nzbFile.hash}.mkv`);
      expect(nzbFileUpdated!.s3Bucket).toBe("openmedia-files");
      expect(nzbFileUpdated!.fileExtension).toBe(".mkv");
      expect(nzbFileUpdated!.downloadedAt).toBeDefined();
    });

    it("lehnt ungültigen Status-Übergang ab", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      // queued → completed is not allowed (must go through intermediate states)
      const res = await request(app)
        .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "completed" });

      expect(res.status).toBe(422);
      expect(res.body.currentStatus).toBe("queued");
    });

    it("erlaubt failed von jedem aktiven Status", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      const res = await request(app)
        .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "failed", error: "VPS konnte nicht erstellt werden" });

      expect(res.status).toBe(200);
      expect(res.body.job.status).toBe("failed");
      expect(res.body.job.error).toBe("VPS konnte nicht erstellt werden");
      expect(res.body.job.completedAt).toBeDefined();
    });

    it("inkrementiert failedAttempts bei failure", async () => {
      const { nzbFile } = await createTestNzbFile();

      // Create job and fail it
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      await request(app)
        .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "failed", error: "SABnzbd: missing articles" });

      const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updatedNzb!.failedAttempts).toBe(1);
      expect(updatedNzb!.status).toBe("untested"); // not yet broken
    });

    it("markiert NZB als broken nach 3 failures", async () => {
      const { nzbFile } = await createTestNzbFile();

      for (let i = 0; i < 3; i++) {
        const createRes = await request(app)
          .post("/downloads/jobs")
          .set("Authorization", `Bearer ${token}`)
          .send({ nzbFileId: nzbFile.id });
        await request(app)
          .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
          .set("Authorization", `Bearer ${token}`)
          .send({ status: "failed", error: "SABnzbd: incomplete download" });
      }

      const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updatedNzb!.failedAttempts).toBe(3);
      expect(updatedNzb!.status).toBe("broken");
      expect(updatedNzb!.brokenReason).toContain("3x fehlgeschlagen");
      expect(updatedNzb!.brokenReason).toContain("incomplete download");
    });

    it("setzt brokenReason nicht wenn NZB bereits broken ist", async () => {
      const { nzbFile } = await createTestNzbFile();
      // Pre-set as broken with a custom reason
      await prisma.nzbFile.update({
        where: { id: nzbFile.id },
        data: { status: "broken", brokenReason: "Manuell markiert", failedAttempts: 5 },
      });

      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });
      await request(app)
        .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "failed", error: "another error" });

      const updatedNzb = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(updatedNzb!.failedAttempts).toBe(6); // still incremented
      expect(updatedNzb!.brokenReason).toBe("Manuell markiert"); // not overwritten
    });
  });

  describe("GET /downloads/jobs/:id/link", () => {
    it("gibt 404 für nicht existierenden Job", async () => {
      const res = await request(app)
        .get("/downloads/jobs/nonexistent-id/link")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("gibt 422 für nicht abgeschlossenen Job", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      const res = await request(app)
        .get(`/downloads/jobs/${createRes.body.job.id}/link`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("abgeschlossene");
    });

    it("gibt 422 wenn kein s3Key vorhanden", async () => {
      const { nzbFile } = await createTestNzbFile();
      // Create a job and force it to completed without s3Key (direct DB manipulation)
      const job = await prisma.downloadJob.create({
        data: { nzbFileId: nzbFile.id, status: "completed", completedAt: new Date() },
      });

      const res = await request(app)
        .get(`/downloads/jobs/${job.id}/link`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
    });
  });

  describe("DELETE /downloads/jobs/:id", () => {
    it("löscht einen queued Job", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      const res = await request(app)
        .delete(`/downloads/jobs/${createRes.body.job.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("verhindert Löschen aktiver Jobs", async () => {
      const { nzbFile } = await createTestNzbFile();
      const createRes = await request(app)
        .post("/downloads/jobs")
        .set("Authorization", `Bearer ${token}`)
        .send({ nzbFileId: nzbFile.id });

      // Move to provisioning (active)
      await request(app)
        .patch(`/downloads/jobs/${createRes.body.job.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "provisioning" });

      const res = await request(app)
        .delete(`/downloads/jobs/${createRes.body.job.id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
    });

    it("gibt 404 für nicht existierenden Job", async () => {
      const res = await request(app)
        .delete("/downloads/jobs/nonexistent-id")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });
  });
});
