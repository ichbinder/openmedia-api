import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("Health & Auth Smoke", () => {
  it("GET /health returns ok with DB connected", async () => {
    const res = await api<{ status: string; db: string; version: string }>("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("connected");
    expect(res.body.version).toBeDefined();
  });

  it("POST /auth/register creates a new user", async () => {
    const user = await createTestUser();

    expect(user.token).toBeDefined();
    expect(user.userId).toBeDefined();
    expect(user.email).toContain("@test.local");
  });

  it("GET /auth/me returns the authenticated user", async () => {
    const user = await createTestUser();

    const res = await api<{ user: { id: string; email: string } }>("/auth/me", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  it("GET /auth/me without token returns 401", async () => {
    const res = await api("/auth/me");

    expect(res.status).toBe(401);
  });

  it("POST /auth/login with correct credentials returns token", async () => {
    const email = `login-test-${Date.now()}@test.local`;
    const password = "TestPass123!";

    // Register first
    await createTestUser({ email, password });

    // Login
    const res = await api<{ token: string }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it("POST /auth/login with wrong password returns 401", async () => {
    const email = `wrong-pass-${Date.now()}@test.local`;
    await createTestUser({ email, password: "CorrectPass123!" });

    const res = await api("/auth/login", {
      method: "POST",
      body: { email, password: "WrongPass456!" },
    });

    expect(res.status).toBe(401);
  });
});
