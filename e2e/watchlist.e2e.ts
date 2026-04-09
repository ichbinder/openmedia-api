import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("Watchlist CRUD", () => {
  it("POST /watchlist adds a movie", async () => {
    const user = await createTestUser();

    const res = await api<{ item: { movieId: number; title: string } }>("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 603, title: "The Matrix", posterPath: "/poster.jpg", voteAverage: 8.7 },
    });

    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe("The Matrix");
  });

  it("GET /watchlist lists user watchlist", async () => {
    const user = await createTestUser();

    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 1, title: "Movie A" },
    });
    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 2, title: "Movie B" },
    });

    const res = await api<{ items: Array<{ title: string }> }>("/watchlist", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("DELETE /watchlist/:movieId removes a movie", async () => {
    const user = await createTestUser();

    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 100, title: "Remove Me" },
    });

    const del = await api("/watchlist/100", {
      method: "DELETE",
      token: user.token,
    });

    expect(del.status).toBe(200);

    const list = await api<{ items: unknown[] }>("/watchlist", { token: user.token });
    expect(list.body.items).toHaveLength(0);
  });

  it("GET /watchlist/check/:movieId checks if movie is in watchlist", async () => {
    const user = await createTestUser();

    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 42, title: "Check Me" },
    });

    const yes = await api<{ inWatchlist: boolean }>("/watchlist/check/42", {
      token: user.token,
    });
    expect(yes.body.inWatchlist).toBe(true);

    const no = await api<{ inWatchlist: boolean }>("/watchlist/check/999", {
      token: user.token,
    });
    expect(no.body.inWatchlist).toBe(false);
  });

  it("POST /watchlist is idempotent (upsert)", async () => {
    const user = await createTestUser();

    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 50, title: "Upsert Test" },
    });

    // Add again — should not create duplicate
    await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { movieId: 50, title: "Upsert Test" },
    });

    const list = await api<{ items: unknown[] }>("/watchlist", { token: user.token });
    expect(list.body.items).toHaveLength(1);
  });

  it("POST /watchlist requires movieId and title", async () => {
    const user = await createTestUser();

    const res = await api("/watchlist", {
      method: "POST",
      token: user.token,
      body: { title: "No movieId" },
    });

    expect(res.status).toBe(400);
  });

  it("watchlist is per-user isolated", async () => {
    const user1 = await createTestUser();
    const user2 = await createTestUser();

    await api("/watchlist", {
      method: "POST",
      token: user1.token,
      body: { movieId: 1, title: "User1 Movie" },
    });

    const list2 = await api<{ items: unknown[] }>("/watchlist", { token: user2.token });
    expect(list2.body.items).toHaveLength(0);
  });
});
