/**
 * SABnzbd API client — sends NZB files to SABnzbd for download.
 *
 * Configuration via environment variables:
 *   SABNZBD_URL     — SABnzbd base URL (e.g. http://192.168.1.100:8080)
 *   SABNZBD_API_KEY — SABnzbd API key (from Config > General > API Key)
 *   SABNZBD_CATEGORY — Download category (optional, e.g. "movies")
 */

const SABNZBD_URL = process.env.SABNZBD_URL || "";
const SABNZBD_API_KEY = process.env.SABNZBD_API_KEY || "";
const SABNZBD_CATEGORY = process.env.SABNZBD_CATEGORY || "";

export interface SabnzbdConfig {
  url: string;
  apiKey: string;
  category: string;
}

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

/**
 * Get current SABnzbd configuration from environment.
 */
export function getSabnzbdConfig(): SabnzbdConfig {
  return {
    url: SABNZBD_URL,
    apiKey: SABNZBD_API_KEY,
    category: SABNZBD_CATEGORY,
  };
}

/**
 * Check if SABnzbd is configured.
 */
export function isSabnzbdConfigured(): boolean {
  return !!(SABNZBD_URL && SABNZBD_API_KEY);
}

/**
 * Send an NZB file to SABnzbd for download.
 *
 * @param nzbContent — raw NZB XML content
 * @param filename — display name for the download
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
    formData.append("apikey", SABNZBD_API_KEY);
    formData.append("mode", "addfile");
    formData.append("output", "json");

    if (SABNZBD_CATEGORY) {
      formData.append("cat", SABNZBD_CATEGORY);
    }

    const res = await fetch(`${SABNZBD_URL}/api`, {
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
      apikey: SABNZBD_API_KEY,
      mode: "queue",
      output: "json",
      limit: "0",
    });

    const res = await fetch(`${SABNZBD_URL}/api?${params}`);

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
    return { connected: false, error: err.message };
  }
}
