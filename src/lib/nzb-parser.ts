import { createHash } from "crypto";

/**
 * Parsed metadata from an NZB release name.
 */
export interface ParsedNzbName {
  /** Extracted movie title (cleaned) */
  title: string;
  /** Year if found */
  year: number | null;
  /** Resolution: "720p", "1080p", "2160p", etc. */
  resolution: string | null;
  /** Audio languages found */
  audioLanguages: string[];
  /** Video codec */
  codec: string | null;
  /** Source type */
  source: string | null;
}

// Known resolution patterns
const RESOLUTION_PATTERNS: [RegExp, string][] = [
  [/2160p|4k|uhd/i, "2160p"],
  [/1080p/i, "1080p"],
  [/720p/i, "720p"],
  [/480p/i, "480p"],
  [/576p/i, "576p"],
];

// Known codec patterns
const CODEC_PATTERNS: [RegExp, string][] = [
  [/x\.?265|h\.?265|hevc/i, "x265"],
  [/x\.?264|h\.?264|avc/i, "x264"],
  [/xvid/i, "XviD"],
  [/av1/i, "AV1"],
];

// Known source patterns
const SOURCE_PATTERNS: [RegExp, string][] = [
  [/blu-?ray|bdrip|brrip/i, "BluRay"],
  [/web-?dl/i, "WEB-DL"],
  [/web-?rip/i, "WEBRip"],
  [/hdtv/i, "HDTV"],
  [/dvdrip/i, "DVDRip"],
  [/remux/i, "Remux"],
];

// Language indicators (DL handled separately below)
const LANGUAGE_PATTERNS: [RegExp, string][] = [
  [/\b(german|deutsch|ger)\b/i, "de"],
  [/\b(english|eng|en)\b/i, "en"],
  [/\b(french|fra|fre)\b/i, "fr"],
  [/\b(spanish|spa|esp)\b/i, "es"],
  [/\b(italian|ita)\b/i, "it"],
  [/\b(japanese|jpn)\b/i, "ja"],
  [/\b(korean|kor)\b/i, "ko"],
  [/\b(russian|rus)\b/i, "ru"],
  [/\b(portuguese|por)\b/i, "pt"],
  [/\b(dutch|nld|dut)\b/i, "nl"],
];

// DL = Dual Language — but NOT when part of "WEB-DL"
// Negative lookbehind ensures "WEB-" is not before "DL"
const DUAL_LANGUAGE_PATTERN = /(?<!WEB[-.])\bDL\b/;

/**
 * Parse an NZB release name to extract metadata.
 *
 * Examples:
 * - "The.Godfather.1972.1080p.BluRay.x264-GROUP" → { title: "The Godfather", year: 1972, resolution: "1080p", ... }
 * - "Der.Pate.German.DL.2160p.WEB-DL.x265-GROUP" → { title: "Der Pate", year: null, resolution: "2160p", audioLanguages: ["de", "en"], ... }
 */
export function parseNzbName(filename: string): ParsedNzbName {
  // Remove file extension
  const name = filename.replace(/\.nzb$/i, "");

  // Extract resolution
  let resolution: string | null = null;
  for (const [pattern, value] of RESOLUTION_PATTERNS) {
    if (pattern.test(name)) {
      resolution = value;
      break;
    }
  }

  // Extract codec
  let codec: string | null = null;
  for (const [pattern, value] of CODEC_PATTERNS) {
    if (pattern.test(name)) {
      codec = value;
      break;
    }
  }

  // Extract source
  let source: string | null = null;
  for (const [pattern, value] of SOURCE_PATTERNS) {
    if (pattern.test(name)) {
      source = value;
      break;
    }
  }

  // Extract languages
  const audioLanguages: string[] = [];
  const isDualLanguage = DUAL_LANGUAGE_PATTERN.test(name);

  for (const [pattern, lang] of LANGUAGE_PATTERNS) {
    if (pattern.test(name) && !audioLanguages.includes(lang)) {
      audioLanguages.push(lang);
    }
  }

  if (isDualLanguage) {
    if (!audioLanguages.includes("de")) audioLanguages.push("de");
    if (!audioLanguages.includes("en")) audioLanguages.push("en");
  }

  // If no languages detected, assume English
  if (audioLanguages.length === 0) {
    audioLanguages.push("en");
  }

  // Extract year — also match at end of string (e.g. "Movie.2024.nzb" → name = "Movie.2024")
  const yearMatch = name.match(/[.\s(_](\d{4})(?:[.\s)_]|$)/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  // Extract title: everything before the first technical marker
  const title = extractTitle(name, year);

  return { title, year, resolution, audioLanguages, codec, source };
}

/**
 * Extract the movie title from a release name.
 * Takes everything before the year or the first technical keyword.
 */
function extractTitle(name: string, year: number | null): string {
  let cutPoint = name.length;

  // Cut at year if found
  if (year) {
    const yearIndex = name.indexOf(String(year));
    if (yearIndex > 0) cutPoint = yearIndex;
  }

  // Cut at first technical keyword if before year
  const technicalPatterns = [
    /\b(720p|1080p|2160p|4k|uhd)\b/i,
    /\b(x264|x265|h264|h265|hevc|xvid|av1)\b/i,
    /\b(BluRay|WEB-DL|WEBRip|HDTV|DVDRip|BDRip|BRRip|Remux)\b/i,
    /\b(German|English|French|Spanish|Italian|DL)\b/i,
    /\b(DTS|AC3|AAC|FLAC|TrueHD|Atmos)\b/i,
    /\b(REPACK|PROPER|RERIP|INTERNAL)\b/i,
  ];

  for (const pattern of technicalPatterns) {
    const match = name.match(pattern);
    if (match && match.index !== undefined && match.index < cutPoint) {
      cutPoint = match.index;
    }
  }

  // Clean up: replace dots/underscores with spaces, trim
  return name
    .slice(0, cutPoint)
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate SHA-256 hash of a buffer.
 */
export function calculateHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
