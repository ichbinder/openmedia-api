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
import { getDownloadProviders, getUploadProviders } from "./usenet-provider-service.js";

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
      const nzb = dbConfig.nzb_service || {};
      const docker = dbConfig.docker_images || {};
      const runtime = dbConfig.runtime || {};

      // Resolve usenet servers from UsenetProvider table
      let usenetServers: UsenetServer[] = [];
      try {
        const providers = await getDownloadProviders();
        if (providers.length > 0) {
          usenetServers = providers.map((p) => ({
            host: p.host,
            port: p.port,
            username: p.username,
            password: p.password,
            ssl: p.ssl,
            connections: p.connections,
          }));
          console.log(`[vps-config] Download servers from UsenetProvider table (${providers.length} providers)`);
        }
      } catch (err) {
        console.warn(`[vps-config] UsenetProvider lookup failed: ${(err as Error).message}`);
      }

      if (usenetServers.length === 0) {
        console.warn("[vps-config] No usenet download servers found — returning null");
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
      const nzb = dbConfig.nzb_service || {};
      const docker = dbConfig.docker_images || {};
      const runtime = dbConfig.runtime || {};

      // Resolve upload providers from UsenetProvider table
      const providers: UploadProvider[] = [];
      try {
        const uploadProviders = await getUploadProviders();
        if (uploadProviders.length > 0) {
          for (const p of uploadProviders) {
            providers.push({
              host: p.postHost || p.host, // prefer postHost for uploads
              port: p.port,
              username: p.username,
              password: p.password,
              ssl: p.ssl,
              connections: p.connections,
            });
          }
          console.log(`[vps-config] Upload providers from UsenetProvider table (${uploadProviders.length} providers)`);
        }
      } catch (err) {
        console.warn(`[vps-config] UsenetProvider lookup failed: ${(err as Error).message}`);
      }

      if (providers.length === 0) {
        console.warn("[vps-config] No upload providers found — returning null");
        return null;
      }
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
