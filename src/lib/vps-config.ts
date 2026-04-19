/**
 * VPS Config Resolution — reads from DB config store.
 *
 * Centralizes the config lookup for both download and upload VPS provisioning.
 * The provisioner and route handlers call these functions instead of reading
 * process.env directly for S3, Usenet, and NZB service credentials.
 * Returns null if DB config is missing or incomplete.
 */

import { getProfileConfig } from "./config-service.js";
import type { UploadProvider } from "./usenet-config.js";
import type { UsenetServer } from "./hetzner.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface DownloadVpsConfig {
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
  apiBaseUrl: string;
  apiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  nzbServiceUrl: string;
  nzbServiceToken: string;
  dockerImage: string;
  usenetProviders: UploadProvider[];
}

// ─── Download VPS Config ──────────────────────────────────────────────

/**
 * Resolve download VPS config from DB config store.
 * Returns null if DB config is missing or incomplete.
 */
export async function getDownloadVpsConfig(): Promise<DownloadVpsConfig | null> {
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
        console.warn("[vps-config] DB config has no usenet servers — returning null");
        return null;
      }

      console.log(`[vps-config] Download config loaded from DB (${Object.keys(dbConfig).length} categories)`);
      return {
        apiBaseUrl: runtime.api_base_url || "",
        apiToken: runtime.service_api_token || "",
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
  } catch (err) {
    console.warn(`[vps-config] DB config lookup failed: ${(err as Error).message}`);
  }

  return null;
}

// ─── Upload VPS Config ────────────────────────────────────────────────

/**
 * Resolve upload VPS config from DB config store.
 * Returns null if DB config is missing or incomplete.
 */
export async function getUploadVpsConfig(): Promise<UploadVpsConfig | null> {
  try {
    const dbConfig = await getProfileConfig("upload_vps");
    if (dbConfig && hasRequiredUploadKeys(dbConfig)) {
      const s3 = dbConfig.s3 || {};
      const usenet = dbConfig.usenet_upload || {};
      const nzb = dbConfig.nzb_service || {};
      const docker = dbConfig.docker_images || {};
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
        console.warn("[vps-config] DB config has no upload providers — returning null");
        return null;
      }

      console.log(`[vps-config] Upload config loaded from DB (${providers.length} providers)`);
      return {
        apiBaseUrl: runtime.api_base_url || "",
        apiToken: runtime.service_api_token || "",
        s3AccessKey: s3.access_key || "",
        s3SecretKey: s3.secret_key || "",
        s3Endpoint: s3.endpoint || "",
        s3Bucket: s3.bucket || "",
        nzbServiceUrl: nzb.url || "",
        nzbServiceToken: nzb.token || "",
        dockerImage: docker.uploader || "ghcr.io/ichbinder/openmedia-uploader:latest",
        usenetProviders: providers,
      };
    }
  } catch (err) {
    console.warn(`[vps-config] DB config lookup failed: ${(err as Error).message}`);
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Check if DB config has the minimum keys needed for download provisioning. */
function hasRequiredDownloadKeys(config: Record<string, Record<string, string>>): boolean {
  const s3 = config.s3;
  const nzb = config.nzb_service;
  const runtime = config.runtime;
  return !!(s3 && s3.access_key && s3.secret_key && s3.endpoint && s3.bucket &&
    nzb && nzb.url &&
    runtime && runtime.api_base_url && runtime.service_api_token);
}

/** Check if DB config has the minimum keys needed for upload provisioning. */
function hasRequiredUploadKeys(config: Record<string, Record<string, string>>): boolean {
  const s3 = config.s3;
  const nzb = config.nzb_service;
  const docker = config.docker_images;
  const runtime = config.runtime;
  return !!(s3 && s3.access_key && s3.secret_key && s3.endpoint && s3.bucket &&
    nzb && nzb.url && nzb.token &&
    docker && docker.uploader &&
    runtime && runtime.api_base_url && runtime.service_api_token);
}
