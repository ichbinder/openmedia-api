/**
 * Jellyfin Plugin Manifest + ZIP-Auslieferung
 *
 * Plugin-Distribution laeuft ueber den `dist`-Branch im Plugin-Repo
 * (openmedia-jellyfin-plugin). Die API zieht von dort `openmedia.zip` und
 * `version.txt`, baked beim Auslefern eine User-spezifische `bootstrap.json`
 * (`{apiUrl, apiToken}`) in die ZIP und liefert sie an Jellyfin aus.
 *
 * Vorteile gegenueber GitHub-Releases:
 *   - Plugin-Versionen bleiben komplett im Plugin-Repo, die API muss keine
 *     Version mehr kennen oder via ENV pflegen.
 *   - User installiert das Plugin und es laeuft sofort — keine manuelle
 *     apiUrl/apiToken-Eingabe noetig (BootstrapLoader picked die Werte auf).
 *
 * Format-Referenz Jellyfin-Manifest:
 *   https://jellyfin.org/docs/general/server/plugins/#creating-a-plugin-repository
 */

import { createHash } from "node:crypto";
import JSZip from "jszip";

export interface JellyfinPluginVersion {
  version: string;
  changelog: string;
  targetAbi: string;
  sourceUrl: string;
  checksum: string;
  timestamp: string;
}

export interface JellyfinPluginManifestEntry {
  guid: string;
  name: string;
  description: string;
  overview: string;
  owner: string;
  category: string;
  imageUrl?: string;
  versions: JellyfinPluginVersion[];
}

/** Felder die wir aus der upstream `meta.json` lesen — alle optional, mit Fallbacks. */
interface UpstreamPluginMeta {
  version?: string;
  guid?: string;
  name?: string;
  description?: string;
  overview?: string;
  owner?: string;
  category?: string;
  imageUrl?: string;
  targetAbi?: string;
  changelog?: string;
  timestamp?: string;
}

const DEFAULT_DIST_REPO = "ichbinder/openmedia-jellyfin-plugin";
const DEFAULT_DIST_BRANCH = "dist";
const DEFAULT_NAME = "openmedia";
const DEFAULT_DESCRIPTION = "Streamt deine openmedia-Bibliothek direkt nach Jellyfin.";
const DEFAULT_OVERVIEW = "Verbindet Jellyfin mit deinem openmedia-Server.";
const DEFAULT_OWNER = "ichbinder";
const DEFAULT_CATEGORY = "General";
const DEFAULT_TARGET_ABI = "10.10.0.0";
const DEFAULT_GUID = "8cfc3c6a-c39f-467f-8ebe-9f3218724aa1";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** ZIP-Eintragsdatum fuer `bootstrap.json` — fix, damit MD5 reproduzierbar bleibt. */
const BOOTSTRAP_FIXED_DATE = new Date("2020-01-01T00:00:00Z");

interface CachedArtifacts {
  version: string;
  zipBuffer: Buffer;
  meta: UpstreamPluginMeta;
  fetchedAt: number;
}

let cache: CachedArtifacts | null = null;

/** Test-Hook: Cache leeren. Niemals im Produktivpfad benutzen. */
export function _resetJellyfinManifestCache(): void {
  cache = null;
}

/** Test-Hook: Fetcher ueberschreiben (statt echte HTTP-Calls). */
type UpstreamFetcher = (path: "version.txt" | "openmedia.zip") => Promise<Buffer | string>;
let upstreamFetcherOverride: UpstreamFetcher | null = null;

export function _setJellyfinUpstreamFetcher(fetcher: UpstreamFetcher | null): void {
  upstreamFetcherOverride = fetcher;
  // Override-Wechsel invalidiert den Cache, sonst koennen Tests sich gegenseitig stoeren.
  cache = null;
}

function getDistBaseUrl(): string {
  const explicit = process.env.JELLYFIN_PLUGIN_DIST_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const repo = (process.env.JELLYFIN_PLUGIN_DIST_REPO?.trim() || DEFAULT_DIST_REPO).replace(/^\/+|\/+$/g, "");
  const branch = process.env.JELLYFIN_PLUGIN_DIST_BRANCH?.trim() || DEFAULT_DIST_BRANCH;
  return `https://raw.githubusercontent.com/${repo}/${branch}`;
}

async function fetchUpstream(path: "version.txt" | "openmedia.zip"): Promise<Buffer | string> {
  if (upstreamFetcherOverride) return upstreamFetcherOverride(path);
  const base = getDistBaseUrl();
  const url = `${base}/${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`upstream fetch failed: ${url} -> HTTP ${res.status}`);
    }
    if (path === "version.txt") return (await res.text()).trim();
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

async function readMetaFromZip(zipBuffer: Buffer): Promise<UpstreamPluginMeta> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const metaFile = zip.file("meta.json");
  if (!metaFile) return {};
  try {
    const text = await metaFile.async("string");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as UpstreamPluginMeta;
  } catch {
    // Defekt — fallen wir auf Defaults zurueck statt die ganze Pipeline zu killen.
  }
  return {};
}

/**
 * Holt upstream-Artefakte (zip + meta) mit kurzem TTL-Cache.
 * Wenn `version.txt` unveraendert ist, behalten wir den gecachten ZIP-Puffer
 * und resetten nur `fetchedAt` — spart einen ZIP-Download.
 */
export async function getUpstreamPluginArtifacts(opts?: { force?: boolean }): Promise<CachedArtifacts> {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const versionRaw = await fetchUpstream("version.txt");
  const version = typeof versionRaw === "string" ? versionRaw.trim() : versionRaw.toString("utf8").trim();
  if (!version) {
    throw new Error("upstream version.txt is empty");
  }

  if (!opts?.force && cache && cache.version === version) {
    cache.fetchedAt = now;
    return cache;
  }

  const zipResult = await fetchUpstream("openmedia.zip");
  const zipBuffer = Buffer.isBuffer(zipResult) ? zipResult : Buffer.from(zipResult, "utf8");
  const meta = await readMetaFromZip(zipBuffer);

  cache = { version, zipBuffer, meta, fetchedAt: now };
  return cache;
}

/**
 * Baut die User-spezifische ZIP: kopiert upstream-Inhalt + injiziert
 * `bootstrap.json` mit `{apiUrl, apiToken}` neben dem DLL.
 *
 * Deterministisch: gleiche (apiBaseUrl, apiToken, upstreamZip) → gleiche Bytes.
 * Damit stimmt der im Manifest deklarierte MD5 mit dem aus dem ZIP-Endpoint
 * gelieferten Inhalt ueberein.
 */
export async function buildPersonalizedPluginZip(opts: {
  apiBaseUrl: string;
  apiToken: string;
}): Promise<{ buffer: Buffer; md5: string; version: string; meta: UpstreamPluginMeta }> {
  const artifacts = await getUpstreamPluginArtifacts();
  const zip = await JSZip.loadAsync(artifacts.zipBuffer);

  const bootstrap = JSON.stringify(
    { apiUrl: opts.apiBaseUrl, apiToken: opts.apiToken },
    null,
    2,
  );
  zip.file("bootstrap.json", bootstrap, { date: BOOTSTRAP_FIXED_DATE });

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const md5 = createHash("md5").update(buffer).digest("hex");

  return { buffer, md5, version: artifacts.version, meta: artifacts.meta };
}

/**
 * Baut das Jellyfin-Repository-Manifest fuer einen einzelnen User.
 *
 * - `sourceUrl` zeigt auf `/jellyfin/plugin.zip?t=<plaintext>` (User-spezifisch).
 * - `checksum` ist der MD5 der personalisierten ZIP — Jellyfin verifiziert ihn
 *   nach dem Download.
 * - Plugin-Metadaten (name, guid, ...) kommen aus der `meta.json` im upstream
 *   ZIP, mit Defaults als Fallback.
 */
export async function buildJellyfinManifest(opts: {
  apiBaseUrl: string;
  apiToken: string;
}): Promise<JellyfinPluginManifestEntry[]> {
  const { md5, version, meta } = await buildPersonalizedPluginZip(opts);
  const safeBase = opts.apiBaseUrl.replace(/\/$/, "");
  const sourceUrl = `${safeBase}/jellyfin/plugin.zip?t=${encodeURIComponent(opts.apiToken)}`;

  const versions: JellyfinPluginVersion[] = [];
  if (version) {
    versions.push({
      version,
      changelog: meta.changelog?.trim() || `${version} — Release`,
      targetAbi: meta.targetAbi?.trim() || DEFAULT_TARGET_ABI,
      sourceUrl,
      checksum: md5,
      timestamp: meta.timestamp?.trim() || new Date().toISOString(),
    });
  }

  const entry: JellyfinPluginManifestEntry = {
    guid: meta.guid?.trim() || DEFAULT_GUID,
    name: meta.name?.trim() || DEFAULT_NAME,
    description: meta.description?.trim() || DEFAULT_DESCRIPTION,
    overview: meta.overview?.trim() || DEFAULT_OVERVIEW,
    owner: meta.owner?.trim() || DEFAULT_OWNER,
    category: meta.category?.trim() || DEFAULT_CATEGORY,
    versions,
  };

  const imageUrl = meta.imageUrl?.trim();
  if (imageUrl) entry.imageUrl = imageUrl;

  return [entry];
}
