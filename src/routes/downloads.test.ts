import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

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

describe("Downloads Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

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
});
