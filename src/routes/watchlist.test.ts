import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

// Helper: register + get token
async function getAuthToken(email = "wl@test.de") {
  const res = await request(app)
    .post("/auth/register")
    .send({ email, password: "test123", name: "WL User" });
  return res.body.token as string;
}

describe("Watchlist Routes", () => {
  let token: string;

  beforeEach(async () => {
    token = await getAuthToken();
  });

  describe("POST /watchlist", () => {
    it("fügt Film zur Watchlist hinzu", async () => {
      const res = await request(app)
        .post("/watchlist")
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

    it("ist idempotent (kein Duplikat)", async () => {
      const movie = { movieId: 550, title: "Fight Club" };

      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`).send(movie);
      const res = await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`).send(movie);

      expect(res.status).toBe(201);

      // List should have exactly 1
      const list = await request(app).get("/watchlist").set("Authorization", `Bearer ${token}`);
      expect(list.body.items).toHaveLength(1);
    });

    it("lehnt fehlende Felder ab", async () => {
      const res = await request(app)
        .post("/watchlist")
        .set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550 });

      expect(res.status).toBe(400);
    });

    it("lehnt unautorisiert ab", async () => {
      const res = await request(app)
        .post("/watchlist")
        .send({ movieId: 550, title: "Fight Club" });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /watchlist", () => {
    it("listet User-Watchlist auf", async () => {
      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });
      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`)
        .send({ movieId: 680, title: "Pulp Fiction" });

      const res = await request(app).get("/watchlist").set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
    });

    it("zeigt nur eigene Filme", async () => {
      // User 1 adds a movie
      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      // User 2 should see empty list
      const token2 = await getAuthToken("other@test.de");
      const res = await request(app).get("/watchlist").set("Authorization", `Bearer ${token2}`);

      expect(res.body.items).toHaveLength(0);
    });
  });

  describe("DELETE /watchlist/:movieId", () => {
    it("entfernt Film aus Watchlist", async () => {
      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      const res = await request(app)
        .delete("/watchlist/550")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify gone
      const list = await request(app).get("/watchlist").set("Authorization", `Bearer ${token}`);
      expect(list.body.items).toHaveLength(0);
    });
  });

  describe("GET /watchlist/check/:movieId", () => {
    it("gibt true für Film in Watchlist", async () => {
      await request(app).post("/watchlist").set("Authorization", `Bearer ${token}`)
        .send({ movieId: 550, title: "Fight Club" });

      const res = await request(app)
        .get("/watchlist/check/550")
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.inWatchlist).toBe(true);
    });

    it("gibt false für Film nicht in Watchlist", async () => {
      const res = await request(app)
        .get("/watchlist/check/999")
        .set("Authorization", `Bearer ${token}`);

      expect(res.body.inWatchlist).toBe(false);
    });
  });
});
