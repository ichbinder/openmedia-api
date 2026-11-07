import { getEntry } from "./config-service.js";
import { cached } from "./ttl-cache.js";

const BASE_URL = "https://treasure-maps.com/api/v1";
const MIN_GAP_MS = 250;
const SEARCH_TTL_MS = 60 * 60 * 1000;
const GUID_PATTERN = /^[a-f0-9]{32}$/;

export interface IndexerRelease {
  guid: string;
  title: string;
  size: number;
  postedAt: string;
  password: number | null;
  season: number | null;
  episode: number | null;
  audioLanguages: string[] | null;
  subtitles: string[] | null;
  videoWidth: number | null;
}

export class IndexerError extends Error {
  constructor(
    public reason: "not_configured" | "rate_limited" | "http",
    public status?: number,
  ) {
    super(`Indexer error: ${reason}${status ? ` (${status})` : ""}`);
    this.name = "IndexerError";
  }
}

interface RawRelease {
  guid: string;
  title: string;
  size: number;
  posted_at: string;
  password?: number | null;
  season?: number | null;
  episode?: number | null;
  audio_languages?: string[] | null;
  subtitles?: string[] | null;
  video?: { resolution?: string } | null;
}

let spacing: Promise<void> = Promise.resolve();
let lastStart = 0;

function awaitSlot(): Promise<void> {
  const slot = spacing.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  spacing = slot;
  return slot;
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

async function send(url: URL, apiKey: string): Promise<Response> {
  await awaitSlot();
  const headers: Record<string, string> = {};
  if (url.origin === new URL(BASE_URL).origin) headers["X-API-Key"] = apiKey;
  try {
    return await fetch(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IndexerError("http");
  }
}

async function request(path: string): Promise<Response> {
  const entry = await getEntry("indexer", "treasureMapsApiKey", true);
  if (!entry?.value) throw new IndexerError("not_configured");
  let url = new URL(`${BASE_URL}${path}`);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await send(url, entry.value);
    const location = res.status >= 300 && res.status < 400 ? res.headers?.get("location") : null;
    if (!location) {
      if (res.status === 429) throw new IndexerError("rate_limited", 429);
      if (!res.ok) throw new IndexerError("http", res.status);
      return res;
    }
    try {
      url = new URL(location, url);
    } catch {
      throw new IndexerError("http", res.status);
    }
  }
  throw new IndexerError("http");
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new IndexerError("http");
  }
}

function videoWidth(release: RawRelease): number | null {
  const width = parseInt(release.video?.resolution?.split("x")[0] ?? "", 10);
  return Number.isNaN(width) ? null : width;
}

function toRelease(raw: RawRelease): IndexerRelease {
  return {
    guid: raw.guid,
    title: raw.title,
    size: raw.size,
    postedAt: raw.posted_at,
    password: raw.password ?? null,
    season: raw.season ?? null,
    episode: raw.episode ?? null,
    audioLanguages: raw.audio_languages ?? null,
    subtitles: raw.subtitles ?? null,
    videoWidth: videoWidth(raw),
  };
}

export function searchEpisode(tmdbId: number, season: number, episode: number): Promise<IndexerRelease[]> {
  return cached(`tm:tv:${tmdbId}:${season}:${episode}`, SEARCH_TTL_MS, async () => {
    const query = new URLSearchParams({
      tmdbid: String(tmdbId),
      season: String(season),
      ep: String(episode),
      cat: "5100",
      extended: "true",
      limit: "100",
    });
    const res = await request(`/tv?${query}`);
    const body = await readJson<{ items?: unknown }>(res);
    if (!Array.isArray(body?.items)) throw new IndexerError("http");
    return (body.items as RawRelease[]).map(toRelease);
  });
}

export async function downloadNzb(guid: string): Promise<string> {
  if (!GUID_PATTERN.test(guid)) throw new IndexerError("http", 400);
  const res = await request(`/releases/${guid}/download`);
  try {
    return await res.text();
  } catch {
    throw new IndexerError("http");
  }
}

export async function getDownloadBudget(): Promise<{ used: number; max: number }> {
  const res = await request("/user");
  const body = await readJson<{ limits?: { download_current?: unknown; download_max?: unknown } }>(res);
  const { download_current: used, download_max: max } = body?.limits ?? {};
  if (typeof used !== "number" || typeof max !== "number") throw new IndexerError("http");
  return { used, max };
}
