import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

let counter = 0;
function uniqueHash(prefix: string) {
  return `${prefix}-dl-${Date.now()}-${++counter}`;
}

/** Create a movie + NZB file and return both IDs */
async function createMovieAndFile(token: string) {
  const hash = uniqueHash("dl");

  const movieRes = await api<{ movie: { id: string } }>("/nzb/movies", {
    method: "POST",
    token,
    body: { titleEn: "DL Test Movie", titleDe: "DL Testfilm", year: 2020 },
  });

  const fileRes = await api<{ nzbFile: { id: string } }>("/nzb/files", {
    method: "POST",
    token,
    body: {
      movieId: movieRes.body.movie.id,
      hash,
      originalFilename: "test.nzb",
      fileSize: 1024,
      resolution: "1080p",
    },
  });

  return {
    movieId: movieRes.body.movie.id,
    nzbFileId: fileRes.body.nzbFile.id,
    hash,
  };
}

describe("Download Jobs", () => {
  it("POST /downloads/jobs creates a download job", async () => {
    const user = await createTestUser();
    const { nzbFileId } = await createMovieAndFile(user.token);

    const res = await api<{ job: { id: string; status: string; nzbFileId: string } }>(
      "/downloads/jobs",
      {
        method: "POST",
        token: user.token,
        body: { nzbFileId },
      },
    );

    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe("queued");
    expect(res.body.job.nzbFileId).toBe(nzbFileId);
  });

  it("POST /downloads/jobs rejects duplicate active job", async () => {
    const user = await createTestUser();
    const { nzbFileId } = await createMovieAndFile(user.token);

    // First job
    await api("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId },
    });

    // Duplicate
    const res = await api("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId },
    });

    expect(res.status).toBe(409);
  });

  it("GET /downloads/jobs lists jobs", async () => {
    const user = await createTestUser();
    const { nzbFileId } = await createMovieAndFile(user.token);

    await api("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId },
    });

    const res = await api<{ jobs: Array<{ id: string }> }>("/downloads/jobs", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /downloads/jobs/:id returns a single job", async () => {
    const user = await createTestUser();
    const { nzbFileId } = await createMovieAndFile(user.token);

    const created = await api<{ job: { id: string } }>("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId },
    });

    const res = await api<{ job: { id: string; status: string } }>(
      `/downloads/jobs/${created.body.job.id}`,
      { token: user.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(created.body.job.id);
  });

  it("GET /downloads/jobs/:id returns 404 for missing job", async () => {
    const user = await createTestUser();

    const res = await api("/downloads/jobs/nonexistent-id", { token: user.token });
    expect(res.status).toBe(404);
  });

  it("DELETE /downloads/jobs/:id deletes a job", async () => {
    const user = await createTestUser();
    const { nzbFileId } = await createMovieAndFile(user.token);

    const created = await api<{ job: { id: string } }>("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId },
    });

    const del = await api(`/downloads/jobs/${created.body.job.id}`, {
      method: "DELETE",
      token: user.token,
    });

    expect(del.status).toBe(200);

    // Verify it's gone
    const get = await api(`/downloads/jobs/${created.body.job.id}`, { token: user.token });
    expect(get.status).toBe(404);
  });

  it("POST /downloads/jobs requires nzbFileId", async () => {
    const user = await createTestUser();

    const res = await api("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: {},
    });

    expect(res.status).toBe(400);
  });

  it("POST /downloads/jobs rejects nonexistent nzbFileId", async () => {
    const user = await createTestUser();

    const res = await api("/downloads/jobs", {
      method: "POST",
      token: user.token,
      body: { nzbFileId: "nonexistent-id" },
    });

    expect(res.status).toBe(404);
  });

  it("all download endpoints require authentication", async () => {
    const res = await api("/downloads/jobs");
    expect(res.status).toBe(401);
  });
});
