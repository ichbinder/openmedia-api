import { getEntry } from "./config-service.js";

const BASE_URL = "https://api.trakt.tv";
const TIMEOUT_MS = 15_000;

type TraktKind = "movie" | "show";

export type TraktLibrary = {
  ratings: { kind: TraktKind; tmdbId: number | null; rating: number }[];
  watched: { kind: TraktKind; tmdbId: number | null }[];
};

export type DeviceLogin = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};

export type DevicePoll =
  | { status: "done"; accessToken: string }
  | { status: "pending" | "expired" | "denied" };

async function clientId(): Promise<string | null> {
  const entry = await getEntry("metadata", "traktClientId", true).catch(() => null);
  return entry?.value || null;
}

const headers = (id: string, accessToken?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  "trakt-api-version": "2",
  "trakt-api-key": id,
  "User-Agent": "openmedia/1.0",
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
});

function post(path: string, id: string, body: object) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(id),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function startDeviceLogin(): Promise<DeviceLogin | "not_configured"> {
  const id = await clientId();
  if (!id) return "not_configured";
  const res = await post("/oauth/device/code", id, { client_id: id });
  if (!res.ok) throw new Error(`Trakt device code: HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, any>;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url,
    expiresIn: body.expires_in,
    interval: body.interval,
  };
}

export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  const id = await clientId();
  if (!id) throw new Error("Trakt nicht konfiguriert");
  const res = await post("/oauth/device/token", id, { code: deviceCode, client_id: id });
  if (res.status === 200) return { status: "done", accessToken: ((await res.json()) as { access_token: string }).access_token };
  if (res.status === 400 || res.status === 429) return { status: "pending" };
  if ([404, 409, 410].includes(res.status)) return { status: "expired" };
  if (res.status === 418) return { status: "denied" };
  throw new Error(`Trakt device token: HTTP ${res.status}`);
}

const validTmdbId = (t: unknown): number | null =>
  typeof t === "number" && Number.isInteger(t) && t > 0 ? t : null;

async function get(path: string, id: string, accessToken: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: headers(id, accessToken),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Trakt ${path}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>[];
}

export async function fetchTraktLibrary(accessToken: string): Promise<TraktLibrary> {
  const id = await clientId();
  if (!id) throw new Error("Trakt nicht konfiguriert");
  const kinds: [TraktKind, string][] = [["movie", "movies"], ["show", "shows"]];
  const lib: TraktLibrary = { ratings: [], watched: [] };
  for (const [kind, plural] of kinds) {
    for (const r of await get(`/sync/ratings/${plural}`, id, accessToken)) {
      lib.ratings.push({ kind, tmdbId: validTmdbId(r[kind]?.ids?.tmdb), rating: r.rating });
    }
    for (const w of await get(`/sync/watched/${plural}${kind === "show" ? "?extended=noseasons" : ""}`, id, accessToken)) {
      lib.watched.push({ kind, tmdbId: validTmdbId(w[kind]?.ids?.tmdb) });
    }
  }
  return lib;
}

export async function revokeToken(accessToken: string): Promise<void> {
  try {
    const id = await clientId();
    if (!id) return;
    const res = await post("/oauth/revoke", id, { token: accessToken, client_id: id });
    if (!res.ok) console.warn(`[trakt] Token-Widerruf fehlgeschlagen: HTTP ${res.status}`);
  } catch (err) {
    console.warn("[trakt] Token-Widerruf fehlgeschlagen:", err instanceof Error ? err.name : "Fehler");
  }
}
