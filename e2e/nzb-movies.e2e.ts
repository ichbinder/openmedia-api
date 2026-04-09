import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("NZB Movies CRUD", () => {
  it("POST /nzb/movies creates a movie", async () => {
    const user = await createTestUser();

    const res = await api<{ movie: { id: string; titleEn: string; titleDe: string } }>(
      "/nzb/movies",
      {
        method: "POST",
        token: user.token,
        body: { titleEn: "The Matrix", titleDe: "Matrix", year: 1999, tmdbId: 603 },
      },
    );

    expect(res.status).toBe(201);
    expect(res.body.movie.titleEn).toBe("The Matrix");
    expect(res.body.movie.titleDe).toBe("Matrix");
  });

  it("GET /nzb/movies lists all movies", async () => {
    const user = await createTestUser();

    await api("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Movie A", titleDe: "Film A" },
    });
    await api("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Movie B", titleDe: "Film B" },
    });

    const res = await api<{ movies: Array<{ titleEn: string }> }>("/nzb/movies", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    const titles = res.body.movies.map((m) => m.titleEn);
    expect(titles).toContain("Movie A");
    expect(titles).toContain("Movie B");
  });

  it("GET /nzb/movies/:id returns a single movie", async () => {
    const user = await createTestUser();

    const created = await api<{ movie: { id: string } }>("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Inception", titleDe: "Inception", year: 2010 },
    });

    const res = await api<{ movie: { id: string; titleEn: string } }>(
      `/nzb/movies/${created.body.movie.id}`,
      { token: user.token },
    );

    expect(res.status).toBe(200);
    expect(res.body.movie.titleEn).toBe("Inception");
  });

  it("PUT /nzb/movies/:id updates a movie", async () => {
    const user = await createTestUser();

    const created = await api<{ movie: { id: string } }>("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Old Title", titleDe: "Alter Titel" },
    });

    const res = await api<{ movie: { titleEn: string } }>(
      `/nzb/movies/${created.body.movie.id}`,
      {
        method: "PUT",
        token: user.token,
        body: { titleEn: "New Title" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.movie.titleEn).toBe("New Title");
  });

  it("DELETE /nzb/movies/:id deletes a movie", async () => {
    const user = await createTestUser();

    const created = await api<{ movie: { id: string } }>("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Delete Me", titleDe: "Lösch Mich" },
    });

    const del = await api(`/nzb/movies/${created.body.movie.id}`, {
      method: "DELETE",
      token: user.token,
    });

    expect(del.status).toBe(200);

    // Verify it's gone
    const get = await api(`/nzb/movies/${created.body.movie.id}`, { token: user.token });
    expect(get.status).toBe(404);
  });

  it("GET /nzb/movies/by-tmdb/:tmdbId finds movie by TMDB ID", async () => {
    const user = await createTestUser();

    await api("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "TMDB Movie", titleDe: "TMDB Film", tmdbId: 99999 },
    });

    const res = await api<{ movie: { titleEn: string } }>("/nzb/movies/by-tmdb/99999", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.movie.titleEn).toBe("TMDB Movie");
  });

  it("GET /nzb/movies/:id returns 404 for missing movie", async () => {
    const user = await createTestUser();

    const res = await api("/nzb/movies/nonexistent-id", { token: user.token });
    expect(res.status).toBe(404);
  });

  it("POST /nzb/movies requires titleDe and titleEn", async () => {
    const user = await createTestUser();

    const res = await api("/nzb/movies", {
      method: "POST",
      token: user.token,
      body: { titleEn: "Only English" },
    });

    expect(res.status).toBe(400);
  });

  it("all NZB endpoints require authentication", async () => {
    const endpoints = [
      { path: "/nzb/movies", method: "GET" },
      { path: "/nzb/movies", method: "POST" },
      { path: "/nzb/movies/test-id", method: "GET" },
      { path: "/nzb/movies/test-id", method: "PUT" },
      { path: "/nzb/movies/test-id", method: "DELETE" },
    ];

    for (const { path, method } of endpoints) {
      const res = await api(path, { method: method as "GET" });
      expect(res.status).toBe(401);
    }
  });
});
