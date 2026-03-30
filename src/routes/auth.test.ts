import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

const app = createApp();

describe("Auth Routes", () => {
  describe("POST /auth/register", () => {
    it("registriert einen neuen User", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({ email: "test@test.de", password: "test123", name: "Test User" });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({
        email: "test@test.de",
        name: "Test User",
      });
      expect(res.body.user.id).toBeDefined();
      expect(res.body.token).toBeDefined();

      // Verify user in DB
      const dbUser = await prisma.user.findUnique({ where: { email: "test@test.de" } });
      expect(dbUser).not.toBeNull();
      expect(dbUser!.name).toBe("Test User");
    });

    it("lehnt doppelte E-Mail ab", async () => {
      await request(app)
        .post("/auth/register")
        .send({ email: "dupe@test.de", password: "test123", name: "First" });

      const res = await request(app)
        .post("/auth/register")
        .send({ email: "dupe@test.de", password: "test123", name: "Second" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("existiert bereits");
    });

    it("lehnt fehlende Felder ab", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({ email: "test@test.de" });

      expect(res.status).toBe(400);
    });

    it("lehnt kurzes Passwort ab", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({ email: "test@test.de", password: "12345", name: "Test" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("6 Zeichen");
    });

    it("normalisiert E-Mail auf lowercase", async () => {
      const res = await request(app)
        .post("/auth/register")
        .send({ email: "TEST@Test.DE", password: "test123", name: "Test" });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe("test@test.de");
    });
  });

  describe("POST /auth/login", () => {
    beforeEach(async () => {
      await request(app)
        .post("/auth/register")
        .send({ email: "login@test.de", password: "test123", name: "Login User" });
    });

    it("loggt einen existierenden User ein", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "login@test.de", password: "test123" });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("login@test.de");
      expect(res.body.token).toBeDefined();
    });

    it("lehnt falsches Passwort ab", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "login@test.de", password: "falsch" });

      expect(res.status).toBe(401);
      expect(res.body.error).toContain("falsch");
    });

    it("lehnt unbekannte E-Mail ab", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "gibts@nicht.de", password: "test123" });

      expect(res.status).toBe(401);
    });

    it("akzeptiert case-insensitive E-Mail", async () => {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "LOGIN@Test.DE", password: "test123" });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /auth/me", () => {
    it("gibt User-Daten mit gültigem Token", async () => {
      const register = await request(app)
        .post("/auth/register")
        .send({ email: "me@test.de", password: "test123", name: "Me User" });

      const res = await request(app)
        .get("/auth/me")
        .set("Authorization", `Bearer ${register.body.token}`);

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("me@test.de");
      expect(res.body.user.name).toBe("Me User");
    });

    it("lehnt Request ohne Token ab", async () => {
      const res = await request(app).get("/auth/me");
      expect(res.status).toBe(401);
    });

    it("lehnt ungültigen Token ab", async () => {
      const res = await request(app)
        .get("/auth/me")
        .set("Authorization", "Bearer invalid-token");

      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    it("gibt success zurück", async () => {
      const res = await request(app).post("/auth/logout");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
