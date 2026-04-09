import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("Auth API Tokens", () => {
  it("POST /auth/api-tokens creates a token", async () => {
    const user = await createTestUser();

    const res = await api<{ token: string; id: string; name: string; prefix: string }>(
      "/auth/api-tokens",
      {
        method: "POST",
        token: user.token,
        body: { name: "Test Token", expiresInDays: 30 },
      },
    );

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^om_/);
    expect(res.body.name).toBe("Test Token");
    expect(res.body.prefix).toBeDefined();
  });

  it("GET /auth/api-tokens lists tokens", async () => {
    const user = await createTestUser();

    // Create a token first
    await api("/auth/api-tokens", {
      method: "POST",
      token: user.token,
      body: { name: "List Test", expiresInDays: 30 },
    });

    const res = await api<{ tokens: Array<{ id: string; name: string }> }>(
      "/auth/api-tokens",
      { token: user.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0].name).toBe("List Test");
  });

  it("DELETE /auth/api-tokens/:id revokes a token", async () => {
    const user = await createTestUser();

    const created = await api<{ id: string }>("/auth/api-tokens", {
      method: "POST",
      token: user.token,
      body: { name: "Revoke Test", expiresInDays: 30 },
    });

    const res = await api(`/auth/api-tokens/${created.body.id}`, {
      method: "DELETE",
      token: user.token,
    });

    expect(res.status).toBe(200);

    // Verify it shows as revoked
    const list = await api<{ tokens: Array<{ id: string; revokedAt: string | null }> }>(
      "/auth/api-tokens",
      { token: user.token },
    );
    expect(list.body.tokens[0].revokedAt).not.toBeNull();
  });

  it("API token can authenticate requests", async () => {
    const user = await createTestUser();

    const created = await api<{ token: string }>("/auth/api-tokens", {
      method: "POST",
      token: user.token,
      body: { name: "Auth Test", expiresInDays: 30 },
    });

    // Use the API token to access /auth/me
    const res = await api<{ user: { email: string } }>("/auth/me", {
      token: created.body.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
  });

  it("POST /auth/register rejects duplicate email", async () => {
    const email = `dup-${Date.now()}@test.local`;
    await createTestUser({ email });

    const res = await api("/auth/register", {
      method: "POST",
      body: { email, password: "TestPass123!", name: "Dup User" },
    });

    expect(res.status).toBe(409);
  });

  it("POST /auth/register rejects short password", async () => {
    const res = await api("/auth/register", {
      method: "POST",
      body: { email: `short-${Date.now()}@test.local`, password: "12345", name: "Short" },
    });

    expect(res.status).toBe(400);
  });

  it("POST /auth/logout returns success", async () => {
    const res = await api("/auth/logout", { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
