import {
  bandDistance,
  dropDatalessTwins,
  hasGermanNameHint,
  hasWord,
  includesGerman,
  TIER_RANK,
  tierOf,
  type Band,
  type QualityTier,
} from "./release-ranking.js";
import { parseNzbName, toLanguageCodes } from "./nzb-parser.js";
import type { IndexerRelease } from "./treasure-maps.js";

export type CandidateGroup = "german" | "foreign" | "cam";
export type CandidateState = "ready" | "available" | "indexer" | "broken";
export const GROUP_RANK: Record<CandidateGroup, number> = {
  german: 0,
  foreign: 1,
  cam: 2,
};

export interface OwnFile {
  id: string;
  hash: string;
  originalFilename: string;
  fileSize: bigint | null;
  qualityTier: string | null;
  videoWidth: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  releaseType: string | null;
  indexerGuid: string | null;
  status: string;
  brokenReason: string | null;
  failedAttempts: number;
  s3Key: string | null;
  mediaInfo: unknown;
}

export interface MovieCandidate {
  key: string;
  nzbFileId: string | null;
  guid: string | null;
  title: string;
  group: CandidateGroup;
  state: CandidateState;
  qualityTier: QualityTier;
  releaseType: string | null;
  sizeBytes: number | null;
  audioLanguages: string[];
  germanSubtitles: boolean;
  audioDescription: boolean;
  inTargetBand: boolean;
  hashPrefix: string | null;
  brokenReason: string | null;
}

const MAX_FAILED_ATTEMPTS = 3;
const CAM_WORDS = [
  "CAM",
  "HDCAM",
  "TS",
  "HDTS",
  "TELESYNC",
  "TC",
  "TELECINE",
  "SCR",
  "SCREENER",
  "DVDSCR",
  "LD",
  "MD",
];
const AUDIO_DESCRIPTION_WORDS = [
  "Hörfilm",
  "Hoerfilm",
  "Audiodeskription",
  "AD",
];
const STATE_RANK: Record<CandidateState, number> = {
  ready: 0,
  available: 1,
  indexer: 2,
  broken: 3,
};

interface Entry {
  candidate: MovieCandidate;
  german: boolean;
  distance: number;
}

function build(
  base: Pick<
    MovieCandidate,
    | "key"
    | "nzbFileId"
    | "guid"
    | "title"
    | "state"
    | "qualityTier"
    | "releaseType"
    | "sizeBytes"
    | "audioLanguages"
    | "germanSubtitles"
    | "hashPrefix"
    | "brokenReason"
  >,
  german: boolean,
  { runtimeMinutes, band }: { runtimeMinutes: number; band: Band },
): Entry {
  const distance =
    base.sizeBytes === null
      ? Infinity
      : bandDistance(base.sizeBytes / 1e9 / (runtimeMinutes / 60), band);
  const inTargetBand = base.qualityTier === "1080p" && distance === 0;
  const group: CandidateGroup = hasWord(base.title, CAM_WORDS)
    ? "cam"
    : german
      ? "german"
      : "foreign";
  const audioDescription = hasWord(base.title, AUDIO_DESCRIPTION_WORDS);
  return {
    candidate: { ...base, group, inTargetBand, audioDescription },
    german,
    distance,
  };
}

function fromRelease(
  r: IndexerRelease,
  opts: { runtimeMinutes: number; band: Band },
): Entry {
  const hasData = r.audioLanguages !== null;
  return build(
    {
      key: `guid:${r.guid}`,
      nzbFileId: null,
      guid: r.guid,
      title: r.title,
      state: "indexer",
      qualityTier: tierOf(r),
      releaseType: parseNzbName(r.title).source,
      sizeBytes: r.size,
      audioLanguages: hasData
        ? toLanguageCodes(r.audioLanguages)
        : parseNzbName(r.title).audioLanguages,
      germanSubtitles: includesGerman(r.subtitles),
      hashPrefix: null,
      brokenReason: null,
    },
    hasData ? includesGerman(r.audioLanguages) : hasGermanNameHint(r.title),
    opts,
  );
}

function fromFile(
  f: OwnFile,
  opts: { runtimeMinutes: number; band: Band },
): Entry {
  const hasMediaInfo = f.mediaInfo !== null && f.mediaInfo !== undefined;
  const audioLanguages = hasMediaInfo ? toLanguageCodes(f.audioLanguages) : [];
  const qualityTier =
    f.videoWidth !== null
      ? tierOf({ videoWidth: f.videoWidth } as IndexerRelease)
      : ((f.qualityTier as QualityTier | null) ?? "480p");
  const state: CandidateState =
    f.status === "broken" ? "broken" : f.s3Key ? "ready" : "available";
  return build(
    {
      key: `file:${f.id}`,
      nzbFileId: f.id,
      guid: f.indexerGuid,
      title: f.originalFilename,
      state,
      qualityTier,
      releaseType: f.releaseType,
      sizeBytes: f.fileSize === null ? null : Number(f.fileSize),
      audioLanguages,
      germanSubtitles: toLanguageCodes(f.subtitleLanguages).includes("de"),
      hashPrefix: f.hash.slice(0, 8),
      brokenReason: f.brokenReason,
    },
    hasMediaInfo
      ? audioLanguages.includes("de")
      : hasGermanNameHint(f.originalFilename),
    opts,
  );
}

export function rankMovieCandidates(
  releases: IndexerRelease[],
  files: OwnFile[],
  opts: { runtimeMinutes: number; band: Band },
): MovieCandidate[] {
  const ownGuids = new Set(
    files.map((f) => f.indexerGuid).filter((g): g is string => g !== null),
  );
  const usable = releases.filter(
    (r) => r.password !== 2 && r.size > 0 && !ownGuids.has(r.guid),
  );
  const entries = [
    ...dropDatalessTwins(usable).map((r) => fromRelease(r, opts)),
    ...files
      .filter((f) => f.failedAttempts < MAX_FAILED_ATTEMPTS)
      .map((f) => fromFile(f, opts)),
  ];

  const tier = (c: MovieCandidate) =>
    c.inTargetBand ? 5 : TIER_RANK[c.qualityTier];
  const bonus = (c: MovieCandidate) =>
    (c.germanSubtitles ? 2 : 0) + (c.audioDescription ? 1 : 0);
  const broken = (c: MovieCandidate) => (c.state === "broken" ? 1 : 0);
  return entries
    .sort((a, b) => {
      const [x, y] = [a.candidate, b.candidate];
      return (
        broken(x) - broken(y) ||
        GROUP_RANK[x.group] - GROUP_RANK[y.group] ||
        (x.group === "cam" ? Number(b.german) - Number(a.german) : 0) ||
        tier(y) - tier(x) ||
        bonus(y) - bonus(x) ||
        STATE_RANK[x.state] - STATE_RANK[y.state] ||
        (x.inTargetBand
          ? (y.sizeBytes ?? 0) - (x.sizeBytes ?? 0)
          : a.distance - b.distance || 0)
      );
    })
    .map((e) => e.candidate);
}
