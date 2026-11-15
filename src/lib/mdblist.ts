import { getEntry } from "./config-service.js";
import {
  META_RULES,
  originLabel,
  storedRatings,
  type Brand,
  type Kind,
  type StoredRatings,
} from "./title-meta.js";

const API_URL = "https://api.mdblist.com";
const BASE_URL = `${API_URL}/tmdb`;

export type MdblistResult =
  | {
      status: "found";
      label: string | null;
      brand: Brand | null;
      ratings: StoredRatings;
      score: number | null;
      year: number | null;
    }
  | { status: "not_found" }
  | { status: "error"; reason: "not_configured" | "rate_limited" | "timeout" | "http" };

interface RawTitle {
  title?: string;
  error?: string;
  year?: number | null;
  score?: number | null;
  network?: string | null;
  released?: string | null;
  releases?: { digital?: { date?: string | null; detail?: string | null } | null } | null;
  ratings?: { source: string; value: number | null; votes?: number | null }[];
}

const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

const isNotFoundBody = (body: RawTitle) =>
  !body.title && typeof body.error === "string" && /not found/i.test(body.error);

export async function fetchMdblistTitle(kind: Kind, tmdbId: number): Promise<MdblistResult> {
  try {
    const entry = await getEntry("metadata", "mdblistApiKey", true).catch(() => null);
    if (!entry?.value) return { status: "error", reason: "not_configured" };

    const query = new URLSearchParams({ apikey: entry.value });
    if (kind === "movie") query.set("append_to_response", "releases");
    const res = await fetch(`${BASE_URL}/${kind}/${tmdbId}/?${query}`, {
      signal: AbortSignal.timeout(META_RULES.TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 429) return { status: "error", reason: "rate_limited" };
    if (!res.ok) return { status: "error", reason: "http" };

    const body = (await res.json()) as RawTitle;
    if (isNotFoundBody(body)) return { status: "not_found" };
    if (!body?.title) return { status: "error", reason: "http" };

    const origin = originLabel(kind, {
      network: body.network,
      digitalDetail: body.releases?.digital?.detail,
      released: body.released,
      digitalDate: body.releases?.digital?.date,
    });
    return {
      status: "found",
      label: origin?.label ?? null,
      brand: origin?.brand ?? null,
      ratings: storedRatings(body.ratings ?? []),
      score: typeof body.score === "number" ? Math.round(body.score) : null,
      year: body.year ?? null,
    };
  } catch (e) {
    return { status: "error", reason: isTimeout(e) ? "timeout" : "http" };
  }
}

export async function mdblistGet(path: string, params: Record<string, string>): Promise<unknown | null> {
  try {
    const entry = await getEntry("metadata", "mdblistApiKey", true).catch(() => null);
    if (!entry?.value) return null;
    const query = new URLSearchParams({ ...params, apikey: entry.value });
    const res = await fetch(`${API_URL}${path}?${query}`, {
      signal: AbortSignal.timeout(META_RULES.TIMEOUT_MS),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
