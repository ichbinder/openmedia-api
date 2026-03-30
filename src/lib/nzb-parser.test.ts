import { describe, it, expect } from "vitest";
import { parseNzbName, calculateHash } from "./nzb-parser.js";

describe("parseNzbName", () => {
  it("parst Standard-Release-Name", () => {
    const result = parseNzbName("The.Godfather.1972.1080p.BluRay.x264-GROUP.nzb");
    expect(result.title).toBe("The Godfather");
    expect(result.year).toBe(1972);
    expect(result.resolution).toBe("1080p");
    expect(result.codec).toBe("x264");
    expect(result.source).toBe("BluRay");
  });

  it("parst deutschen Release mit DL", () => {
    const result = parseNzbName("Der.Pate.German.DL.2160p.WEB-DL.x265-GROUP.nzb");
    expect(result.title).toBe("Der Pate");
    expect(result.resolution).toBe("2160p");
    expect(result.audioLanguages).toContain("de");
    expect(result.audioLanguages).toContain("en");
    expect(result.codec).toBe("x265");
    expect(result.source).toBe("WEB-DL");
  });

  it("parst 4K/UHD", () => {
    const result = parseNzbName("Movie.Name.2024.4K.UHD.BluRay.x265.nzb");
    expect(result.resolution).toBe("2160p");
  });

  it("parst 720p WEBRip", () => {
    const result = parseNzbName("Some.Movie.720p.WEBRip.x264.nzb");
    expect(result.resolution).toBe("720p");
    expect(result.source).toBe("WEBRip");
  });

  it("nimmt Englisch als Default wenn keine Sprache", () => {
    const result = parseNzbName("Matrix.1999.1080p.BluRay.x264.nzb");
    expect(result.audioLanguages).toEqual(["en"]);
  });

  it("erkennt German ohne DL", () => {
    const result = parseNzbName("Film.German.1080p.BluRay.x264.nzb");
    expect(result.audioLanguages).toContain("de");
  });

  it("handelt fehlende Metadaten", () => {
    const result = parseNzbName("random-file.nzb");
    expect(result.title).toBe("random-file");
    expect(result.resolution).toBeNull();
    expect(result.codec).toBeNull();
    expect(result.source).toBeNull();
  });

  it("parst Underscores als Trennzeichen", () => {
    const result = parseNzbName("The_Dark_Knight_2008_1080p_BluRay_x264.nzb");
    expect(result.title).toBe("The Dark Knight");
    expect(result.year).toBe(2008);
  });

  it("erkennt HEVC als x265", () => {
    const result = parseNzbName("Movie.2024.1080p.HEVC-GROUP.nzb");
    expect(result.codec).toBe("x265");
  });

  it("erkennt Remux Source", () => {
    const result = parseNzbName("Movie.2024.1080p.Remux.AVC-GROUP.nzb");
    expect(result.source).toBe("Remux");
  });
});

describe("calculateHash", () => {
  it("berechnet SHA-256 Hash", () => {
    const hash = calculateHash(Buffer.from("test content"));
    expect(hash).toBe("6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72");
    expect(hash).toHaveLength(64);
  });

  it("gibt unterschiedliche Hashes für unterschiedliche Inhalte", () => {
    const hash1 = calculateHash(Buffer.from("content A"));
    const hash2 = calculateHash(Buffer.from("content B"));
    expect(hash1).not.toBe(hash2);
  });

  it("gibt gleichen Hash für gleichen Inhalt", () => {
    const hash1 = calculateHash(Buffer.from("same content"));
    const hash2 = calculateHash(Buffer.from("same content"));
    expect(hash1).toBe(hash2);
  });
});
