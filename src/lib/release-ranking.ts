import { getEntry } from "./config-service.js";
import { parseNzbName, resolveQualityTier } from "./nzb-parser.js";
import type { IndexerRelease } from "./treasure-maps.js";

export type QualityTier = "2160p" | "1080p" | "720p" | "480p";

export interface RankedRelease extends IndexerRelease {
  qualityTier: QualityTier;
  inTargetBand: boolean;
  gbPerHour: number;
  germanSubtitles: boolean;
  audioDescription: boolean;
  languageSource: "mediainfo" | "name";
  releaseType: string | null;
}

export interface Band {
  min: number;
  max: number;
}

const DEFAULT_BAND: Band = { min: 1.5, max: 6 };
export const TIER_RANK: Record<QualityTier, number> = { "1080p": 4, "2160p": 3, "720p": 2, "480p": 1 };

export function hasWord(title: string, words: string[]): boolean {
  return new RegExp(`(^|[._\\- ])(${words.join("|")})($|[._\\- ])`, "i").test(title);
}

export function hasGermanNameHint(title: string): boolean {
  return hasWord(title.replace(/(WEB|HD|BD)[._\- ]DL/gi, "$1"), ["German", "Deutsch", "DL"]);
}

export function includesGerman(list: string[] | null): boolean {
  return !!list?.some((l) => l.toLowerCase() === "german");
}

export function tierOf(release: IndexerRelease): QualityTier {
  const width = release.videoWidth;
  if (width !== null) {
    if (width >= 3000) return "2160p";
    if (width >= 1700) return "1080p";
    if (width >= 1200) return "720p";
    return "480p";
  }
  return (resolveQualityTier(parseNzbName(release.title).resolution) as QualityTier | null) ?? "480p";
}

export function bandDistance(gbPerHour: number, band: Band): number {
  if (gbPerHour < band.min) return band.min - gbPerHour;
  if (gbPerHour > band.max) return gbPerHour - band.max;
  return 0;
}

export function dropDatalessTwins(releases: IndexerRelease[]): IndexerRelease[] {
  const withData = new Set(releases.filter((r) => r.audioLanguages !== null).map((r) => r.title.toLowerCase()));
  return releases.filter((r) => r.audioLanguages !== null || !withData.has(r.title.toLowerCase()));
}

export function rankReleases(
  releases: IndexerRelease[],
  opts: { season: number; episode: number; runtimeMinutes: number; band: Band },
): RankedRelease[] {
  const { season, episode, band } = opts;
  const runtimeMinutes = Number.isFinite(opts.runtimeMinutes) && opts.runtimeMinutes > 0 ? opts.runtimeMinutes : 45;
  const candidates = releases.filter((r) => r.season === season && r.episode === episode && r.password !== 2);

  const ranked: RankedRelease[] = [];
  for (const r of dropDatalessTwins(candidates)) {
    const hasData = r.audioLanguages !== null;
    if (hasData ? !includesGerman(r.audioLanguages) : !hasGermanNameHint(r.title)) continue;
    const qualityTier = tierOf(r);
    const gbPerHour = r.size / 1e9 / (runtimeMinutes / 60);
    ranked.push({
      ...r,
      qualityTier,
      gbPerHour,
      inTargetBand: qualityTier === "1080p" && bandDistance(gbPerHour, band) === 0,
      germanSubtitles: includesGerman(r.subtitles),
      audioDescription: hasWord(r.title, ["Hörfilm", "Hoerfilm", "Audiodeskription", "AD"]),
      languageSource: hasData ? "mediainfo" : "name",
      releaseType: parseNzbName(r.title).source,
    });
  }

  const rank = (r: RankedRelease) => (r.inTargetBand ? 5 : TIER_RANK[r.qualityTier]);
  const bonus = (r: RankedRelease) => (r.germanSubtitles ? 2 : 0) + (r.audioDescription ? 1 : 0);
  return ranked.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      bonus(b) - bonus(a) ||
      (a.inTargetBand ? b.size - a.size : bandDistance(a.gbPerHour, band) - bandDistance(b.gbPerHour, band)),
  );
}

async function readPositive(key: string, fallback: number): Promise<number> {
  const value = Number((await getEntry("series", key, false))?.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function getTargetBand(): Promise<Band> {
  const band = {
    min: await readPositive("targetGbPerHourMin", DEFAULT_BAND.min),
    max: await readPositive("targetGbPerHourMax", DEFAULT_BAND.max),
  };
  return band.min < band.max ? band : DEFAULT_BAND;
}
