/**
 * ZIP-Source-Cache mit GitHub-Release-Fetch
 *
 * Holt das latest Release-ZIP vom Plugin-Repo auf GitHub (via API-Token oder
 * anonym), cacht in-memory mit TTL 1h. Bei Fetch-Fehler wird der Error
 * gecached (TTL 5min) damit Folgerequests 503 zurueckgeben statt erneut zu
 * haengen.
 *
 * ENV:
 *   JELLYFIN_PLUGIN_REPO    – "owner/repo" (default: ichbinder/openmedia-jellyfin-plugin)
 *   JELLYFIN_PLUGIN_VERSION – pinned Version statt "latest"
 *   GITHUB_API_TOKEN        – optional PAT fuer hoehere Rate-Limits
 */

const SUCCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const ERROR_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 15_000;

interface CacheEntry {
  buffer: Buffer;
  version: string;
  fetchedAt: number;
  /** Wenn gesetzt, ist dieser Eintrag ein Error-Cache-TTL. */
  error?: string;
}

let cache: CacheEntry | null = null;

// ---------------------------------------------------------------------------
// Test-Hooks
// ---------------------------------------------------------------------------

/** Cache leeren — nur fuer Tests. */
export function _resetPluginSourceCache(): void {
  cache = null;
}

/** Fetcher ueberschreiben — nur fuer Tests. */
export type GithubFetcher = (
  repo: string,
  version: string | null,
) => Promise<{ buffer: Buffer; version: string }>;

let fetcherOverride: GithubFetcher | null = null;

export function _setGithubFetcher(fetcher: GithubFetcher | null): void {
  fetcherOverride = fetcher;
  cache = null; // Override-Wechsel invalidiert Cache
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function getRepo(): string {
  return (process.env.JELLYFIN_PLUGIN_REPO?.trim() || "ichbinder/openmedia-jellyfin-plugin").replace(/^\/+|\/+$/g, "");
}

function getPinnedVersion(): string | null {
  const v = process.env.JELLYFIN_PLUGIN_VERSION?.trim();
  return v || null;
}

function getAuthToken(): string | null {
  return process.env.GITHUB_API_TOKEN?.trim() || null;
}

async function githubFetch(
  repo: string,
  version: string | null,
): Promise<{ buffer: Buffer; version: string }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let downloadUrl: string;
  let resolvedVersion: string;

  if (version) {
    // Pinned version — fetch specific release by tag
    const tagUrl = `https://api.github.com/repos/${repo}/releases/tags/v${version.replace(/^v/, "")}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(tagUrl, { headers, signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`GitHub release tag fetch failed: ${tagUrl} -> HTTP ${res.status}`);
      }
      const release = (await res.json()) as { assets?: { name: string; browser_download_url: string }[]; tag_name?: string };
      const asset = release.assets?.find((a) => a.name === "openmedia.zip");
      if (!asset) {
        throw new Error(`openmedia.zip asset not found in release v${version}`);
      }
      downloadUrl = asset.browser_download_url;
      resolvedVersion = (release.tag_name || version).replace(/^v/, "");
    } finally {
      clearTimeout(timer);
    }
  } else {
    // Latest release
    const latestUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(latestUrl, { headers, signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`GitHub latest release fetch failed: ${latestUrl} -> HTTP ${res.status}`);
      }
      const release = (await res.json()) as { assets?: { name: string; browser_download_url: string }[]; tag_name?: string };
      const asset = release.assets?.find((a) => a.name === "openmedia.zip");
      if (!asset) {
        throw new Error(`openmedia.zip asset not found in latest release`);
      }
      downloadUrl = asset.browser_download_url;
      resolvedVersion = (release.tag_name || "unknown").replace(/^v/, "");
    } finally {
      clearTimeout(timer);
    }
  }

  // Download the ZIP
  const dlCtrl = new AbortController();
  const dlTimer = setTimeout(() => dlCtrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const dlRes = await fetch(downloadUrl, { signal: dlCtrl.signal });
    if (!dlRes.ok) {
      throw new Error(`GitHub ZIP download failed: ${downloadUrl} -> HTTP ${dlRes.status}`);
    }
    const buffer = Buffer.from(await dlRes.arrayBuffer());
    return { buffer, version: resolvedVersion };
  } finally {
    clearTimeout(dlTimer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PluginSourceResult {
  buffer: Buffer;
  version: string;
}

/**
 * Holt das Plugin-Source-ZIP (gecached).
 * Liefert bei Error-Cache einen geworfenen Error (kein stiller 503).
 */
export async function getPluginSourceZip(): Promise<PluginSourceResult> {
  const now = Date.now();

  if (cache) {
    const ttl = cache.error ? ERROR_TTL_MS : SUCCESS_TTL_MS;
    if (now - cache.fetchedAt < ttl) {
      if (cache.error) {
        console.error(
          `[plugin-source] cache-hit (error): version=${cache.version} error="${cache.error}"`,
        );
        throw new Error(`cached upstream error: ${cache.error}`);
      }
      console.log(
        `[plugin-source] cache-hit: version=${cache.version} size=${cache.buffer.length}`,
      );
      return { buffer: cache.buffer, version: cache.version };
    }
    // TTL expired — fall through to re-fetch
  }

  console.log("[plugin-source] cache-miss: fetching from GitHub");

  const repo = getRepo();
  const pinnedVersion = getPinnedVersion();

  try {
    const result = fetcherOverride
      ? await fetcherOverride(repo, pinnedVersion)
      : await githubFetch(repo, pinnedVersion);

    cache = {
      buffer: result.buffer,
      version: result.version,
      fetchedAt: Date.now(),
    };

    console.log(
      `[plugin-source] fetch-success: version=${result.version} size=${result.buffer.length}`,
    );

    return { buffer: result.buffer, version: result.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[plugin-source] fetch-error: version=${pinnedVersion || "latest"} error="${message}"`,
    );

    // Error cachen mit kürzerer TTL
    cache = {
      buffer: Buffer.alloc(0),
      version: pinnedVersion || "unknown",
      fetchedAt: Date.now(),
      error: message,
    };

    throw err;
  }
}
