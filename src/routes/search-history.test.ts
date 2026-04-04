import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

async function getAuthToken(email = "sh@test.de") {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "test123", name: "SH User" });
  return res.body.token as string;
}

describe("Search History Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  describe("POST /search-history", () => {
    it("fügt Film zur Suchhistorie hinzu", async () => {
      const res = await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({
          movieId: 550,
          title: "Fight Club",
          posterPath: "/poster.jpg",
          voteAverage: 8.4,
          releaseDate: "1999-10-15",
        });

      expect(res.status).toBe(201);
      expect(res.body.item.movieId).toBe(550);
      expect(res.body.item.title).toBe("Fight Club");
    });

    it("aktualisiert searchedAt bei erneutem Speichern", async () => {
      const movie = { movieId: 550, title: "Fight Club" };

      const first = await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send(movie);

      // Wait briefly to ensure different timestamp
      await new Promise((r) => setTimeout(r, 50));

      const second = await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send(movie);

      expect(second.status).toBe(201);
      expect(new Date(second.body.item.searchedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(first.body.item.searchedAt).getTime());

      // Should still be only 1 entry
      const list = await request(app)
        .get("/search-history")
        .set("Authorization", `Bearer ${token}`);
      expect(list.body.items).toHaveLength(1);
    });

    it("lehnt fehlende Pflichtfelder ab", async () => {
      const res = await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550 });

      expect(res.status).toBe(400);
    });

    it("erfordert Auth", async () => {
      const res = await request(app)
        .post("/search-history")
        .send({ movieId: 550, title: "Test" });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /search-history", () => {
    it("gibt leere Liste zurück wenn keine Einträge", async () => {
      const res = await request(app)
        .get("/search-history")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it("gibt Einträge sortiert nach searchedAt zurück", async () => {
      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      await new Promise((r) => setTimeout(r, 50));

      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 603, title: "Matrix" });

      const res = await request(app)
        .get("/search-history")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].title).toBe("Matrix");
      expect(res.body.items[1].title).toBe("Fight Club");
    });

    it("respektiert limit Parameter", async () => {
      for (let i = 1; i <= 5; i++) {
        await request(app)
          .post("/search-history")
          .set("Authorization", `Bearer ${token}`)
          .send({ movieId: i, title: `Film ${i}` });
      }

      const res = await request(app)
        .get("/search-history?limit=3")
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.items).toHaveLength(3);
    });

    it("erfordert Auth", async () => {
      const res = await request(app).get("/search-history");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /search-history", () => {
    it("löscht gesamte Suchhistorie", async () => {
      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 603, title: "Matrix" });

      const del = await request(app)
        .delete("/search-history")
        .set("Authorization", `Bearer ${token}`);

      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const list = await request(app)
        .get("/search-history")
        .set("Authorization", `Bearer ${token}`);

      expect(list.body.items).toHaveLength(0);
    });
  });

  describe("DELETE /search-history/:movieId", () => {
    it("entfernt einzelnen Film aus Suchhistorie", async () => {
      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      await request(app)
        .post("/search-history")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 603, title: "Matrix" });

      const del = await request(app)
        .delete("/search-history/550")
        .set("Authorization", `Bearer ${token}`);

      expect(del.status).toBe(200);

      const list = await request(app)
        .get("/search-history")
        .set("Authorization", `Bearer ${token}`);

      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0].title).toBe("Matrix");
    });

    it("lehnt ungültige movieId ab", async () => {
      const res = await request(app)
        .delete("/search-history/abc")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });
});
