import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

let counter = 0;
function uniqueHash(prefix: string) {
  return `${prefix}-${Date.now()}-${++counter}`;
}

/** Helper: create a movie and return its ID */
async function createMovie(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api<{ movie: { id: string } }>("/nzb/movies", {
    method: "POST",
    token,
    body: { titleEn: "Test Movie", titleDe: "Testfilm", ...overrides },
  });
  return res.body.movie.id;
}

describe("NZB Files CRUD", () => {
  it("POST /nzb/files creates an NZB file", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("create");

    const res = await api<{ nzbFile: { id: string; hash: string } }>("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 1024, resolution: "1080p" },
    });

    expect(res.status).toBe(201);
    expect(res.body.nzbFile.hash).toBe(hash);
  });

  it("PUT /nzb/files/:id updates an NZB file", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("update");

    const created = await api<{ nzbFile: { id: string } }>("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 1024, resolution: "720p" },
    });

    const res = await api<{ nzbFile: { resolution: string } }>(
      `/nzb/files/${created.body.nzbFile.id}`,
      {
        method: "PUT",
        token: user.token,
        body: { resolution: "4K" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.nzbFile.resolution).toBe("4K");
  });

  it("DELETE /nzb/files/:id deletes an NZB file", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("delete");

    const created = await api<{ nzbFile: { id: string } }>("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 1024, resolution: "1080p" },
    });

    const del = await api(`/nzb/files/${created.body.nzbFile.id}`, {
      method: "DELETE",
      token: user.token,
    });

    expect(del.status).toBe(200);
  });

  it("GET /nzb/files/by-hash/:hash finds file by hash", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("lookup");

    await api("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 2048, resolution: "1080p" },
    });

    const res = await api<{ nzbFile: { hash: string } }>(`/nzb/files/by-hash/${hash}`, {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.nzbFile.hash).toBe(hash);
  });

  it("PATCH /nzb/files/:id/status updates file status", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("status");

    const created = await api<{ nzbFile: { id: string } }>("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 1024, resolution: "1080p" },
    });

    const res = await api<{ nzbFile: { status: string } }>(
      `/nzb/files/${created.body.nzbFile.id}/status`,
      {
        method: "PATCH",
        token: user.token,
        body: { status: "broken", brokenReason: "Missing segments" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.nzbFile.status).toBe("broken");
  });

  it("PATCH /nzb/files/:id/status rejects invalid status", async () => {
    const user = await createTestUser();
    const movieId = await createMovie(user.token);
    const hash = uniqueHash("invalid-status");

    const created = await api<{ nzbFile: { id: string } }>("/nzb/files", {
      method: "POST",
      token: user.token,
      body: { movieId, hash, originalFilename: "test.nzb", fileSize: 1024, resolution: "1080p" },
    });

    const res = await api(`/nzb/files/${created.body.nzbFile.id}/status`, {
      method: "PATCH",
      token: user.token,
      body: { status: "invalid_status" },
    });

    expect(res.status).toBe(400);
  });
});
