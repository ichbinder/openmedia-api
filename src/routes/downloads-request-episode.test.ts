import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "../test/setup.js";

vi.mock("../lib/s3.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, fileExists: vi.fn().mockResolvedValue(true) };
});

vi.mock("../lib/nzb-service.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, storeNzbInService: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../lib/tmdb.js", () => ({
  searchTmdbMovie: vi.fn().mockResolvedValue({
    status: "found",
    movie: {
      tmdbId: 999_002,
      imdbId: "tt9990002",
      titleDe: "Some Film",
      titleEn: "Some Film",
      description: "Film.",
      year: 2020,
      posterPath: null,
    },
  }),
  searchTmdbShowEpisode: vi.fn(),
}));

import { searchTmdbMovie, searchTmdbShowEpisode } from "../lib/tmdb.js";

const mockMovie = vi.mocked(searchTmdbMovie);
const mockShow = vi.mocked(searchTmdbShowEpisode);
const app = createApp();

function nzb(tag: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="a@b.c" date="1" subject="${tag} [1/1] &quot;x.rar&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="1" number="1">${tag}@test.com</segment></segments>
  </file>
</nzb>`;
}

const show = {
  tmdbId: 95396,
  titleDe: "Severance",
  titleEn: "Severance",
  description: "Show.",
  year: 2022,
  posterPath: "/s.jpg",
};

function foundEpisode(n: number) {
  mockShow.mockResolvedValueOnce({
    status: "found",
    show,
    episode: { titleDe: `Folge ${n}`, airDate: "2025-02-14", runtime: null },
  });
}

let counter = 0;
describe("POST /downloads/request (Serien)", () => {
  let token: string;

  beforeEach(async () => {
    mockMovie.mockClear();
    mockShow.mockReset();
    counter++;
    const res = await request(app)
      .post("/auth/register")
      .send({ email: `ep-${counter}-${Date.now()}@test.de`, password: "test123", name: "Ep User" });
    token = res.body.token;
  });

  function post(tag: string, filename: string) {
    return request(app)
      .post("/downloads/request")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbContent: nzb(tag), title: "Severance", filename });
  }

  it("ordnet SxxEyy-NZB einer Folge zu", async () => {
    foundEpisode(5);
    const res = await post("ep5", "Severance.S02E05.German.DL.1080p.WEB.x264-FuN.nzb");

    expect(res.status).toBe(201);
    expect(res.body.needsReview).toBe(false);
    const file = await prisma.nzbFile.findFirstOrThrow({ where: { originalFilename: { startsWith: "Severance.S02E05" } } });
    expect(file.episodeId).not.toBeNull();
    expect(file.movieId).toBeNull();
    expect(await prisma.nzbShow.count({ where: { tmdbId: 95396 } })).toBe(1);
    const episodes = await prisma.nzbEpisode.findMany();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ season: 2, episode: 5, titleDe: "Folge 5" });
    expect(episodes[0].airDate?.toISOString().slice(0, 10)).toBe("2025-02-14");
    expect(res.body.job.nzbFile.episode).toMatchObject({
      id: file.episodeId,
      season: 2,
      episode: 5,
      titleDe: "Folge 5",
      show: { tmdbId: 95396, titleDe: "Severance", titleEn: "Severance", year: 2022, posterPath: "/s.jpg" },
    });
    expect(mockMovie).not.toHaveBeenCalled();
  });

  it("legt für weitere Folge der Serie keine zweite NzbShow an", async () => {
    foundEpisode(5);
    await post("ep5b", "Severance.S02E05.German.DL.1080p.WEB.x264-FuN.nzb");
    foundEpisode(6);
    const res = await post("ep6", "Severance.S02E06.German.DL.1080p.WEB.x264-FuN.nzb");

    expect(res.status).toBe(201);
    expect(await prisma.nzbShow.count()).toBe(1);
    expect(await prisma.nzbEpisode.count()).toBe(2);
  });

  it("not_found setzt needs_review ohne Folge", async () => {
    mockShow.mockResolvedValueOnce({ status: "not_found" });
    const res = await post("nf", "Severance.S02E07.German.DL.1080p.WEB.x264-FuN.nzb");

    expect(res.status).toBe(201);
    expect(res.body.needsReview).toBe(true);
    expect(res.body.job.status).toBe("needs_review");
    expect(res.body.job.nzbFile.episodeId).toBeNull();
    expect(await prisma.nzbEpisode.count()).toBe(0);
  });

  it("Film-Namen laufen weiter über den Film-Pfad", async () => {
    const res = await post("film", "Some.Film.2020.1080p.BluRay.x264-GRP.nzb");

    expect(res.status).toBe(201);
    expect(mockShow).not.toHaveBeenCalled();
    expect(res.body.job.nzbFile.movieId).not.toBeNull();
    expect(res.body.job.nzbFile.episodeId).toBeNull();
  });

  it("erneute Anfrage derselben bekannten Folge landet nicht im Review", async () => {
    foundEpisode(5);
    const first = await post("again", "Severance.S02E05.German.DL.1080p.WEB.x264-FuN.nzb");
    await prisma.downloadJob.updateMany({ where: { nzbFileId: first.body.job.nzbFileId }, data: { status: "completed" } });

    const second = await post("again", "Severance.S02E05.German.DL.1080p.WEB.x264-FuN.nzb");

    expect(second.status).toBe(201);
    expect(second.body.reused).toBe(true);
    expect(second.body.needsReview).toBe(false);
    expect(second.body.job.status).not.toBe("needs_review");
    expect(second.body.job.nzbFile.episode).toMatchObject({ season: 2, episode: 5, show: { tmdbId: 95396 } });
  });

  it("POST /jobs für Folgen-NzbFile liefert kein 409", async () => {
    foundEpisode(8);
    const first = await post("jobs", "Severance.S02E08.German.DL.1080p.WEB.x264-FuN.nzb");
    const nzbFileId = first.body.job.nzbFileId;
    await prisma.downloadJob.updateMany({ where: { nzbFileId }, data: { status: "failed" } });

    const res = await request(app)
      .post("/downloads/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ nzbFileId });

    expect(res.status).toBe(201);
  });
});
