/**
 * SABnzbd API client — sends NZB files to SABnzbd for download.
 *
 * Configuration via environment variables:
 *   SABNZBD_URL     — SABnzbd base URL (e.g. http://192.168.1.100:8080)
 *   SABNZBD_API_KEY — SABnzbd API key (from Config > General > API Key)
 *   SABNZBD_CATEGORY — Download category (optional, e.g. "movies")
 */

const FETCH_TIMEOUT_MS = 30_000;

export interface SabnzbdSendResult {
  success: boolean;
  nzoIds?: string[];
  error?: string;
}

export interface SabnzbdStatusResult {
  connected: boolean;
  version?: string;
  paused?: boolean;
  speedLimit?: string;
  diskSpace?: string;
  error?: string;
}

/** Read config fresh from env every time — no module-level caching */
function getUrl(): string {
  return process.env.SABNZBD_URL || "";
}

function getApiKey(): string {
  return process.env.SABNZBD_API_KEY || "";
}

function getCategory(): string {
  return process.env.SABNZBD_CATEGORY || "";
}

/**
 * Check if SABnzbd is configured.
 */
export function isSabnzbdConfigured(): boolean {
  return !!(getUrl() && getApiKey());
}

/**
 * Get SABnzbd config summary (no secrets exposed).
 */
export function getSabnzbdConfigSummary(): { configured: boolean; category: string | null } {
  return {
    configured: isSabnzbdConfigured(),
    category: getCategory() || null,
  };
}

/** Create a fetch with timeout via AbortController */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send an NZB file to SABnzbd for download.
 */
export async function sendToSabnzbd(
  nzbContent: string | Buffer,
  filename: string
): Promise<SabnzbdSendResult> {
  if (!isSabnzbdConfigured()) {
    return { success: false, error: "SABnzbd ist nicht konfiguriert (SABNZBD_URL / SABNZBD_API_KEY fehlen)." };
  }

  try {
    const formData = new FormData();
    const blob = new Blob([nzbContent], { type: "application/x-nzb" });
    formData.append("nzbfile", blob, filename.endsWith(".nzb") ? filename : `${filename}.nzb`);
    formData.append("apikey", getApiKey());
    formData.append("mode", "addfile");
    formData.append("output", "json");

    const category = getCategory();
    if (category) {
      formData.append("cat", category);
    }

    const res = await fetchWithTimeout(`${getUrl()}/api`, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      return { success: false, error: `SABnzbd HTTP ${res.status}: ${res.statusText}` };
    }

    const data = (await res.json()) as Record<string, any>;

    if (data.status === false || data.error) {
      return { success: false, error: data.error || "SABnzbd hat die NZB abgelehnt." };
    }

    console.log(`[sabnzbd] Sent: ${filename} → nzo_ids: ${JSON.stringify(data.nzo_ids)}`);

    return {
      success: true,
      nzoIds: data.nzo_ids || [],
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { success: false, error: "SABnzbd Timeout — keine Antwort innerhalb von 30 Sekunden." };
    }
    console.error("[sabnzbd] Send error:", err.message);
    return { success: false, error: `Verbindung zu SABnzbd fehlgeschlagen: ${err.message}` };
  }
}

/**
 * Check SABnzbd connection and get status.
 */
export async function getSabnzbdStatus(): Promise<SabnzbdStatusResult> {
  if (!isSabnzbdConfigured()) {
    return { connected: false, error: "SABnzbd ist nicht konfiguriert." };
  }

  try {
    const params = new URLSearchParams({
      apikey: getApiKey(),
      mode: "queue",
      output: "json",
      limit: "0",
    });

    const res = await fetchWithTimeout(`${getUrl()}/api?${params}`);

    if (!res.ok) {
      return { connected: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as Record<string, any>;
    const queue = data.queue || {};

    return {
      connected: true,
      version: queue.version || undefined,
      paused: queue.paused === true,
      speedLimit: queue.speedlimit || undefined,
      diskSpace: queue.diskspace1 ? `${queue.diskspace1} GB` : undefined,
    };
  } catch (err: any) {
    if (err.name === "AbortError") {
      return { connected: false, error: "Timeout — SABnzbd antwortet nicht." };
    }
    return { connected: false, error: err.message };
  }
}
