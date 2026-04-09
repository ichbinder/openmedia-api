import { describe, it, expect } from "vitest";
import { api } from "./helpers/api-client.js";
import { createTestUser } from "./helpers/auth.js";

describe("Search History CRUD", () => {
  it("POST /search-history adds an entry", async () => {
    const user = await createTestUser();

    const res = await api<{ item: { movieId: number; title: string } }>("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 603, title: "The Matrix", voteAverage: 8.7 },
    });

    expect(res.status).toBe(201);
    expect(res.body.item.title).toBe("The Matrix");
  });

  it("GET /search-history lists entries", async () => {
    const user = await createTestUser();

    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 1, title: "Movie A" },
    });
    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 2, title: "Movie B" },
    });

    const res = await api<{ items: Array<{ title: string }> }>("/search-history", {
      token: user.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("GET /search-history respects limit param", async () => {
    const user = await createTestUser();

    for (let i = 1; i <= 5; i++) {
      await api("/search-history", {
        method: "POST",
        token: user.token,
        body: { movieId: i, title: `Movie ${i}` },
      });
    }

    const res = await api<{ items: unknown[] }>("/search-history?limit=3", {
      token: user.token,
    });

    expect(res.body.items).toHaveLength(3);
  });

  it("POST /search-history upserts (updates searchedAt)", async () => {
    const user = await createTestUser();

    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 10, title: "Upsert Test" },
    });

    // Add again
    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 10, title: "Upsert Test Updated" },
    });

    const list = await api<{ items: Array<{ title: string }> }>("/search-history", {
      token: user.token,
    });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].title).toBe("Upsert Test Updated");
  });

  it("DELETE /search-history clears all entries", async () => {
    const user = await createTestUser();

    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 1, title: "A" },
    });
    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 2, title: "B" },
    });

    const del = await api("/search-history", {
      method: "DELETE",
      token: user.token,
    });
    expect(del.status).toBe(200);

    const list = await api<{ items: unknown[] }>("/search-history", { token: user.token });
    expect(list.body.items).toHaveLength(0);
  });

  it("DELETE /search-history/:movieId removes single entry", async () => {
    const user = await createTestUser();

    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 1, title: "Keep" },
    });
    await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { movieId: 2, title: "Remove" },
    });

    await api("/search-history/2", {
      method: "DELETE",
      token: user.token,
    });

    const list = await api<{ items: Array<{ title: string }> }>("/search-history", {
      token: user.token,
    });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].title).toBe("Keep");
  });

  it("POST /search-history requires movieId and title", async () => {
    const user = await createTestUser();

    const res = await api("/search-history", {
      method: "POST",
      token: user.token,
      body: { title: "No movieId" },
    });

    expect(res.status).toBe(400);
  });
});
