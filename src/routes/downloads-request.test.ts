import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

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
});
