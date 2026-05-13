import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock the S3 lib BEFORE importing the app — the route uses dynamic import,
// but vi.mock hoists so the dynamic import resolves to the mock.
vi.mock("../lib/s3.js", () => ({
  isS3Configured: vi.fn(() => true),
  generatePresignedUrl: vi.fn(
    async (key: string, ttl?: number, opts?: { bucket?: string; responseContentType?: string }) =>
      `https://s3.example/${opts?.bucket ?? "default"}/${key}?expires=${ttl ?? 0}`,
  ),
  getFileMetadata: vi.fn(async (key: string) => ({
    key,
    size: 1234,
    contentType: "video/mp4",
    lastModified: new Date(),
    etag: "etag",
  })),
}));

import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";
import { signToken } from "../middleware/auth.js";
import * as s3Mock from "../lib/s3.js";

const app = createApp();

async function createUserAndToken(email?: string) {
  const user = await prisma.user.create({
    data: {
      email: email || `jf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.de`,
      password: "$2b$10$hash",
      name: "Jellyfin Test",
    },
  });
  const token = signToken({ userId: user.id, email: user.email });
  return { user, token };
}

async function createMovieAndNzb(opts: {
  tmdbId?: number | null;
  titleDe?: string;
  titleEn?: string;
  year?: number;
  s3Key?: string | null;
  s3StreamKey?: string | null;
  fileExtension?: string | null;
  fileSize?: bigint | null;
  duration?: number | null;
  qualityTier?: string | null;
  hash?: string;
}) {
  const movie = await prisma.nzbMovie.create({
    data: {
      tmdbId: opts.tmdbId === undefined ? 12345 + Math.floor(Math.random() * 100000) : opts.tmdbId,
      titleDe: opts.titleDe || "Testfilm",
      titleEn: opts.titleEn || "Test Movie",
      year: opts.year ?? 2024,
    },
  });
  const nzbFile = await prisma.nzbFile.create({
    data: {
      movieId: movie.id,
      hash: opts.hash || `jfhash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      originalFilename: "test.nzb",
      s3Key: opts.s3Key ?? null,
      s3StreamKey: opts.s3StreamKey ?? null,
      s3Bucket: opts.s3Key || opts.s3StreamKey ? "openmedia-files" : null,
      fileExtension: opts.fileExtension ?? (opts.s3Key ? ".mkv" : null),
      downloadedAt: opts.s3Key ? new Date() : null,
      fileSize: opts.fileSize ?? null,
      duration: opts.duration ?? null,
      qualityTier: opts.qualityTier ?? null,
    },
  });
  return { movie, nzbFile };
}

beforeEach(() => {
  vi.mocked(s3Mock.isS3Configured).mockReturnValue(true);
  vi.mocked(s3Mock.generatePresignedUrl).mockImplementation(
    async (key: string, ttl?: number, opts?: { bucket?: string; responseContentType?: string }) =>
      `https://s3.example/${opts?.bucket ?? "default"}/${key}?expires=${ttl ?? 0}`,
  );
  vi.mocked(s3Mock.getFileMetadata).mockImplementation(async (key: string) => ({
    key,
    size: 1234,
    contentType: "video/mp4",
    lastModified: new Date(),
    etag: "etag",
  }));
});

describe("Jellyfin Routes", () => {
  describe("auth", () => {
    it("/jellyfin/library lehnt ohne Token ab", async () => {
      const res = await request(app).get("/jellyfin/library");
      expect(res.status).toBe(401);
    });

    it("/jellyfin/stream/:hash lehnt ohne Token ab", async () => {
      const res = await request(app).get("/jellyfin/stream/anyhash");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /jellyfin/library", () => {
    it("liefert leeres Array für neuen User", async () => {
      const { token } = await createUserAndToken();
      const res = await request(app)
        .get("/jellyfin/library")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it("liefert nur Items mit s3Key (heruntergeladen)", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile: withS3 } = await createMovieAndNzb({
        s3Key: "abc/abc.mkv",
        fileSize: 5_000_000_000n,
        duration: 7320,
        qualityTier: "1080p",
        titleDe: "Mit Film",
        titleEn: "With File",
      });
      const { nzbFile: withoutS3 } = await createMovieAndNzb({
        titleDe: "Ohne Film",
        titleEn: "Without File",
      });

      await prisma.userLibrary.createMany({
        data: [
          { userId: user.id, nzbFileId: withS3.id },
          { userId: user.id, nzbFileId: withoutS3.id },
        ],
      });

      const res = await request(app)
        .get("/jellyfin/library")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        hash: withS3.hash,
        title: "Mit Film",
        year: 2024,
        fileSize: "5000000000",
        duration: 7320,
        resolution: "1080p",
      });
      expect(typeof res.body.items[0].tmdbId).toBe("number");
    });

    it("filtert Items ohne tmdbId raus", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile: noTmdb } = await createMovieAndNzb({
        tmdbId: null,
        s3Key: "noTmdb/noTmdb.mkv",
      });
      const { nzbFile: withTmdb } = await createMovieAndNzb({
        tmdbId: 99999,
        s3Key: "withTmdb/withTmdb.mkv",
      });

      await prisma.userLibrary.createMany({
        data: [
          { userId: user.id, nzbFileId: noTmdb.id },
          { userId: user.id, nzbFileId: withTmdb.id },
        ],
      });

      const res = await request(app)
        .get("/jellyfin/library")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].tmdbId).toBe(99999);
    });

    it("isoliert User — fremde Library ist nicht sichtbar", async () => {
      const { user: userA } = await createUserAndToken();
      const { token: tokenB } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({ s3Key: "iso/iso.mkv" });
      await prisma.userLibrary.create({ data: { userId: userA.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get("/jellyfin/library")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });
  });

  describe("GET /jellyfin/stream/:hash", () => {
    it("liefert 404 wenn Hash unbekannt", async () => {
      const { token } = await createUserAndToken();
      const res = await request(app)
        .get("/jellyfin/stream/nope-no-such-hash")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it("liefert 404 wenn Hash existiert aber nicht in der eigenen Library", async () => {
      const { user: owner } = await createUserAndToken();
      const { token: other } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({ s3Key: "secret/secret.mkv" });
      await prisma.userLibrary.create({ data: { userId: owner.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${other}`);

      expect(res.status).toBe(404);
    });

    it("liefert 422 wenn weder s3Key noch s3StreamKey gesetzt", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({}); // kein S3
      await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
    });

    it("302 redirect zur Presigned-URL bei MKV-Original (mime=video/x-matroska)", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({
        s3Key: "mkv/mkv.mkv",
        fileExtension: ".mkv",
      });
      await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${token}`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/s3\.example\/openmedia-files\/mkv\/mkv\.mkv/);
      expect(res.headers["cache-control"]).toBe("no-store");
      // generatePresignedUrl wurde mit dem Persisted-Bucket und MIME aufgerufen
      const lastCall = vi.mocked(s3Mock.generatePresignedUrl).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe("mkv/mkv.mkv");
      expect(lastCall?.[2]).toMatchObject({
        bucket: "openmedia-files",
        responseContentType: "video/x-matroska",
      });
    });

    it("bevorzugt s3StreamKey über s3Key und nutzt mime=video/mp4", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({
        s3Key: "orig/orig.mkv",
        s3StreamKey: "stream/stream.mp4",
        fileExtension: ".mkv",
      });
      await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${token}`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^https:\/\/s3\.example\/openmedia-files\/stream\/stream\.mp4/);
      expect(vi.mocked(s3Mock.getFileMetadata).mock.calls.at(-1)?.[0]).toBe("stream/stream.mp4");
      const lastCall = vi.mocked(s3Mock.generatePresignedUrl).mock.calls.at(-1);
      expect(lastCall?.[2]?.responseContentType).toBe("video/mp4");
    });

    it("FILE_GONE: S3 404 resettet DB und antwortet mit 410", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({
        s3Key: "gone/gone.mkv",
        fileExtension: ".mkv",
      });
      await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

      // Simulate S3 NotFound on HEAD
      vi.mocked(s3Mock.getFileMetadata).mockRejectedValueOnce(
        Object.assign(new Error("NotFound"), {
          name: "NotFound",
          $metadata: { httpStatusCode: 404 },
        }),
      );

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(410);
      expect(res.body.code).toBe("FILE_GONE");

      const refreshed = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(refreshed?.s3Key).toBeNull();
      expect(refreshed?.s3StreamKey).toBeNull();
      expect(refreshed?.s3Bucket).toBeNull();
      expect(refreshed?.fileExtension).toBeNull();
      expect(refreshed?.downloadedAt).toBeNull();
    });

    describe("?token Query-Fallback (M040/S01)", () => {
      it("akzeptiert ?token=<jwt> ohne Authorization-Header (302)", async () => {
        const { user, token } = await createUserAndToken();
        const { nzbFile } = await createMovieAndNzb({
          s3Key: "qt/qt.mkv",
          fileExtension: ".mkv",
        });
        await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

        const res = await request(app)
          .get(`/jellyfin/stream/${nzbFile.hash}`)
          .query({ token })
          .redirects(0);

        expect(res.status).toBe(302);
        expect(res.headers.location).toMatch(/^https:\/\/s3\.example\/openmedia-files\/qt\/qt\.mkv/);
      });

      it("lehnt malformed ?token mit 401 ab — Token-Wert taucht NICHT in der Response auf", async () => {
        const { nzbFile } = await createMovieAndNzb({ s3Key: "mf/mf.mkv" });
        const badToken = "this-is-not-a-valid-jwt-but-long-enough-12345";

        const res = await request(app)
          .get(`/jellyfin/stream/${nzbFile.hash}`)
          .query({ token: badToken })
          .redirects(0);

        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toContain(badToken);
      });

      it("lehnt zu kurze ?token mit 401 ab (laenge < MIN_TOKEN_LEN)", async () => {
        const { nzbFile } = await createMovieAndNzb({ s3Key: "sh/sh.mkv" });
        const res = await request(app)
          .get(`/jellyfin/stream/${nzbFile.hash}`)
          .query({ token: "kurz" })
          .redirects(0);

        expect(res.status).toBe(401);
      });

      it("Header gewinnt ueber ?token wenn beide gesetzt sind (gueltiger Header → 302)", async () => {
        const { user, token } = await createUserAndToken();
        const { nzbFile } = await createMovieAndNzb({
          s3Key: "both/both.mkv",
          fileExtension: ".mkv",
        });
        await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

        const res = await request(app)
          .get(`/jellyfin/stream/${nzbFile.hash}`)
          .query({ token: "invalid-query-token-value-12345" })
          .set("Authorization", `Bearer ${token}`)
          .redirects(0);

        expect(res.status).toBe(302);
      });

      it("/jellyfin/library akzeptiert KEIN ?token-Fallback → 401", async () => {
        const { token } = await createUserAndToken();
        const res = await request(app).get("/jellyfin/library").query({ token });
        expect(res.status).toBe(401);
      });

      it("strippt ?token aus req.query und req.url AUCH wenn Authorization-Header gewinnt", async () => {
        const { streamTokenFallback } = await import("../routes/jellyfin.js");
        const leaky = "leaky-token-value-that-must-not-survive-1234567890";
        const req = {
          path: "/stream/abc123",
          url: `/stream/abc123?token=${leaky}&foo=bar`,
          query: { token: leaky, foo: "bar" } as Record<string, unknown>,
          headers: { authorization: "Bearer some-other-header-token" },
        };
        const next = vi.fn();
        streamTokenFallback(req as never, {} as never, next as never);
        expect(next).toHaveBeenCalledOnce();
        expect(req.query.token).toBeUndefined();
        expect(req.url).not.toContain("token=");
        expect(req.url).not.toContain(leaky);
        // Foo-Param bleibt erhalten
        expect(req.url).toContain("foo=bar");
        // Header bleibt unangetastet
        expect(req.headers.authorization).toBe("Bearer some-other-header-token");
      });

      it("strippt ?token aus req.query und req.url AUCH bei zu kurzem/zu langem Token", async () => {
        const { streamTokenFallback } = await import("../routes/jellyfin.js");
        // Zu kurz: < MIN_TOKEN_LEN (20)
        const shortTok = "abc";
        const reqShort = {
          path: "/stream/hash1",
          url: `/stream/hash1?token=${shortTok}`,
          query: { token: shortTok } as Record<string, unknown>,
          headers: {} as Record<string, string>,
        };
        const next1 = vi.fn();
        streamTokenFallback(reqShort as never, {} as never, next1 as never);
        expect(next1).toHaveBeenCalledOnce();
        expect(reqShort.query.token).toBeUndefined();
        expect(reqShort.url).not.toContain("token=");
        expect(reqShort.headers.authorization).toBeUndefined();

        // Zu lang: > MAX_TOKEN_LEN (4096)
        const longTok = "z".repeat(5000);
        const reqLong = {
          path: "/stream/hash2",
          url: `/stream/hash2?token=${longTok}`,
          query: { token: longTok } as Record<string, unknown>,
          headers: {} as Record<string, string>,
        };
        const next2 = vi.fn();
        streamTokenFallback(reqLong as never, {} as never, next2 as never);
        expect(next2).toHaveBeenCalledOnce();
        expect(reqLong.query.token).toBeUndefined();
        expect(reqLong.url).not.toContain("token=");
        expect(reqLong.url).not.toContain(longTok);
        expect(reqLong.headers.authorization).toBeUndefined();
      });

      it("loggt den Token-Wert nicht (console.log enthaelt das Token nirgendwo)", async () => {
        const { user, token } = await createUserAndToken();
        const { nzbFile } = await createMovieAndNzb({
          s3Key: "log/log.mkv",
          fileExtension: ".mkv",
        });
        await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
          const res = await request(app)
            .get(`/jellyfin/stream/${nzbFile.hash}`)
            .query({ token })
            .redirects(0);
          expect(res.status).toBe(302);
          for (const call of logSpy.mock.calls) {
            const line = call.map(String).join(" ");
            expect(line).not.toContain(token);
          }
        } finally {
          logSpy.mockRestore();
        }
      });
    });

    it("502 bei transienten S3-Fehlern, ohne DB-Reset", async () => {
      const { user, token } = await createUserAndToken();
      const { nzbFile } = await createMovieAndNzb({
        s3Key: "transient/transient.mkv",
        fileExtension: ".mkv",
      });
      await prisma.userLibrary.create({ data: { userId: user.id, nzbFileId: nzbFile.id } });

      vi.mocked(s3Mock.getFileMetadata).mockRejectedValueOnce(
        Object.assign(new Error("Timeout"), { $metadata: { httpStatusCode: 503 } }),
      );

      const res = await request(app)
        .get(`/jellyfin/stream/${nzbFile.hash}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(502);

      const refreshed = await prisma.nzbFile.findUnique({ where: { id: nzbFile.id } });
      expect(refreshed?.s3Key).toBe("transient/transient.mkv");
    });
  });
});
