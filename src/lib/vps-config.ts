/**
 * VPS Config Resolution — reads from DB config store, falls back to ENV.
 *
 * Centralizes the config lookup for both download and upload VPS provisioning.
 * The provisioner and route handlers call these functions instead of reading
 * process.env directly for S3, Usenet, and NZB service credentials.
 */

import { getProfileConfig } from "./config-service.js";
import { parseUsenetServersFromEnv, parseUploadProvidersFromEnv, type UploadProvider } from "./usenet-config.js";
import type { UsenetServer } from "./hetzner.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface DownloadVpsConfig {
  source: "db" | "env";
  apiBaseUrl: string;
  apiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  nzbServiceUrl: string;
  dockerImage: string;
  usenetServers: UsenetServer[];
}

export interface UploadVpsConfig {
  source: "db" | "env";
  apiBaseUrl: string;
  apiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  nzbServiceUrl: string;
  nzbServiceToken: string;
  usenetProviders: UploadProvider[];
}

// ─── Download VPS Config ──────────────────────────────────────────────

/**
 * Resolve download VPS config: DB config store first, ENV fallback.
 * Returns null if neither source has sufficient config.
 */
export async function getDownloadVpsConfig(): Promise<DownloadVpsConfig | null> {
  // Try DB config store first
  try {
    const dbConfig = await getProfileConfig("download_vps");
    if (dbConfig && hasRequiredDownloadKeys(dbConfig)) {
      const s3 = dbConfig.s3 || {};
      const usenet = dbConfig.usenet_download || {};
      const nzb = dbConfig.nzb_service || {};
      const docker = dbConfig.docker_images || {};
      const runtime = dbConfig.runtime || {};

      // Parse usenet servers from DB config
      let usenetServers: UsenetServer[] = [];
      if (usenet.servers) {
        try {
          const parsed = JSON.parse(usenet.servers);
          if (Array.isArray(parsed) && parsed.every((s: unknown) => typeof s === "object" && s !== null && "host" in s && "username" in s && "password" in s)) {
            usenetServers = parsed as UsenetServer[];
          } else {
            console.warn("[vps-config] usenet.servers JSON is not a valid UsenetServer array");
          }
        } catch {
          console.warn("[vps-config] Failed to parse usenet.servers JSON from DB config");
        }
      }

      if (usenetServers.length === 0) {
        console.warn("[vps-config] DB config has no usenet servers — falling back to ENV");
      } else {
        console.log(`[vps-config] Download config loaded from DB (${Object.keys(dbConfig).length} categories)`);
        return {
          source: "db",
          apiBaseUrl: runtime.api_base_url || process.env.API_BASE_URL || "http://localhost:4000",
          apiToken: runtime.service_api_token || process.env.SERVICE_API_TOKEN || "",
          s3AccessKey: s3.access_key || "",
          s3SecretKey: s3.secret_key || "",
          s3Endpoint: s3.endpoint || "",
          s3Bucket: s3.bucket || "",
          s3Region: s3.region || "hel1",
          nzbServiceUrl: nzb.url || "",
          dockerImage: docker.downloader || "ghcr.io/ichbinder/openmedia-downloader:latest",
          usenetServers,
        };
      }
    }
  } catch (err) {
    console.warn(`[vps-config] DB config lookup failed, falling back to ENV: ${(err as Error).message}`);
  }

  // Fallback: ENV-based config
  const required = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "API_BASE_URL", "NZB_SERVICE_URL", "SERVICE_API_TOKEN"];
  const missing = required.filter((v) => !process.env[v]);
  if (!process.env.USENET_SERVERS && !process.env.USENET_HOST) {
    missing.push("USENET_SERVERS or USENET_HOST");
  }
  if (missing.length > 0) {
    return null;
  }

  const usenetServers = parseUsenetServersFromEnv();
  if (usenetServers.length === 0) return null;

  console.log("[vps-config] Download config loaded from ENV (DB config empty or unavailable)");
  return {
    source: "env",
    apiBaseUrl: process.env.API_BASE_URL!,
    apiToken: process.env.SERVICE_API_TOKEN!,
    s3AccessKey: process.env.S3_ACCESS_KEY!,
    s3SecretKey: process.env.S3_SECRET_KEY!,
    s3Endpoint: process.env.S3_ENDPOINT!,
    s3Bucket: process.env.S3_BUCKET!,
    s3Region: process.env.S3_REGION || "hel1",
    nzbServiceUrl: process.env.NZB_SERVICE_URL!,
    dockerImage: process.env.DOWNLOADER_DOCKER_IMAGE || "ghcr.io/ichbinder/openmedia-downloader:latest",
    usenetServers,
  };
}

// ─── Upload VPS Config ────────────────────────────────────────────────

/**
 * Resolve upload VPS config: DB config store first, ENV fallback.
 * Returns null if neither source has sufficient config.
 */
export async function getUploadVpsConfig(): Promise<UploadVpsConfig | null> {
  // Try DB config store first
  try {
    const dbConfig = await getProfileConfig("upload_vps");
    if (dbConfig && hasRequiredUploadKeys(dbConfig)) {
      const s3 = dbConfig.s3 || {};
      const usenet = dbConfig.usenet_upload || {};
      const nzb = dbConfig.nzb_service || {};
      const runtime = dbConfig.runtime || {};

      // Parse upload providers from DB config
      const providers: UploadProvider[] = [];
      for (let i = 1; i <= 3; i++) {
        const host = usenet[`provider_${i}_host`];
        const user = usenet[`provider_${i}_user`];
        if (!host || !user) continue;
        const port = parseInt(usenet[`provider_${i}_port`] || "563", 10);
        const connections = parseInt(usenet[`provider_${i}_conns`] || "20", 10);
        providers.push({
          host,
          port: Number.isNaN(port) ? 563 : port,
          username: user,
          password: usenet[`provider_${i}_pass`] || "",
          ssl: usenet[`provider_${i}_ssl`] !== "0" && usenet[`provider_${i}_ssl`] !== "false",
          connections: Number.isNaN(connections) ? 20 : connections,
        });
      }

      if (providers.length === 0) {
        console.warn("[vps-config] DB config has no upload providers — falling back to ENV");
      } else {
        console.log(`[vps-config] Upload config loaded from DB (${providers.length} providers)`);
        return {
          source: "db",
          apiBaseUrl: runtime.api_base_url || process.env.API_BASE_URL || "http://localhost:4000",
          apiToken: runtime.service_api_token || process.env.SERVICE_API_TOKEN || "",
          s3AccessKey: s3.access_key || "",
          s3SecretKey: s3.secret_key || "",
          s3Endpoint: s3.endpoint || "",
          s3Bucket: s3.bucket || "",
          nzbServiceUrl: nzb.url || "",
          nzbServiceToken: nzb.token || "",
          usenetProviders: providers,
        };
      }
    }
  } catch (err) {
    console.warn(`[vps-config] DB config lookup failed, falling back to ENV: ${(err as Error).message}`);
  }

  // Fallback: ENV-based config
  const required = ["SERVICE_API_TOKEN", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "NZB_SERVICE_URL", "NZB_SERVICE_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) return null;

  const usenetProviders = parseUploadProvidersFromEnv();
  if (usenetProviders.length === 0) return null;

  console.log(`[vps-config] Upload config loaded from ENV (${usenetProviders.length} providers)`);
  return {
    source: "env",
    apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4000",
    apiToken: process.env.SERVICE_API_TOKEN || "",
    s3AccessKey: process.env.S3_ACCESS_KEY || "",
    s3SecretKey: process.env.S3_SECRET_KEY || "",
    s3Endpoint: process.env.S3_ENDPOINT || "",
    s3Bucket: process.env.S3_BUCKET || "",
    nzbServiceUrl: process.env.NZB_SERVICE_URL!,
    nzbServiceToken: process.env.NZB_SERVICE_TOKEN || "",
    usenetProviders,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Check if DB config has the minimum keys needed for download provisioning. */
function hasRequiredDownloadKeys(config: Record<string, Record<string, string>>): boolean {
  const s3 = config.s3;
  const nzb = config.nzb_service;
  return !!(s3 && s3.access_key && s3.secret_key && s3.endpoint && s3.bucket && nzb && nzb.url);
}

/** Check if DB config has the minimum keys needed for upload provisioning. */
function hasRequiredUploadKeys(config: Record<string, Record<string, string>>): boolean {
  const s3 = config.s3;
  const nzb = config.nzb_service;
  return !!(s3 && s3.access_key && s3.secret_key && s3.endpoint && s3.bucket && nzb && nzb.url);
}
