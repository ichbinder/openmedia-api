/**
 * VPS Config Resolution — reads from DB config store.
 *
 * Centralizes the config lookup for both download and upload VPS provisioning.
 * The provisioner and route handlers call these functions instead of reading
 * process.env directly for S3, Usenet, and NZB service credentials.
 * Returns null if DB config is missing or incomplete.
 */

import { getProfileConfig, getEntry } from "./config-service.js";
import type { UploadProvider } from "./usenet-config.js";
import type { UsenetServer } from "./hetzner.js";
import { getDownloadProviders, getUploadProviders } from "./usenet-provider-service.js";
import { resolveVpnConfig, type VpnConfigResolved, type VpnBypassEntry } from "./vpn-config.js";
import prisma from "./prisma.js";

// ─── Types ────────────────────────────────────────────────────────────

/** A host+port pair that MUST be routed through the VPN tunnel */
export interface MustVpnTarget {
  host: string;
  port: number;
}

/** Traffic routing policy for the VPS traffic guard */
export interface RoutingPolicy {
  /** Connections that MUST go through VPN (wg0/tun0) — usenet hosts */
  mustVpn: MustVpnTarget[];
  /** CIDRs that MUST go directly (eth0) — S3, API, metadata, private net */
  mustDirect: string[];
}

export interface DownloadVpsConfig {
  apiBaseUrl: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  nzbServiceUrl: string;
  dockerImage: string;
  usenetServers: UsenetServer[];
  vpnConfig: VpnConfigResolved | null;
  routingPolicy: RoutingPolicy | null;
}

export interface UploadVpsConfig {
  apiBaseUrl: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  nzbServiceUrl: string;
  nzbServiceToken: string;
  dockerImage: string;
  usenetProviders: UploadProvider[];
  vpnConfig: VpnConfigResolved | null;
  routingPolicy: RoutingPolicy | null;
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
            priority: p.priority,
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

      // Resolve VPN config from vpn/downloadVpnProviderId config key
      const vpnConfig = await resolveVpnForProfile("downloadVpnProviderId");

      // Build routing policy for traffic guard
      const routingPolicy = buildRoutingPolicy(
        usenetServers.map((s) => ({ host: s.host, port: s.port ?? 563 })),
        vpnConfig?.excludedCIDRs ?? null,
      );

      console.log(`[vps-config] Download config loaded from DB (${Object.keys(dbConfig).length} categories, vpn: ${vpnConfig ? "yes" : "no"})`);
      return {
        apiBaseUrl: runtime.api_base_url || "",
        s3AccessKey: s3.access_key || "",
        s3SecretKey: s3.secret_key || "",
        s3Endpoint: s3.endpoint || "",
        s3Bucket: s3.bucket || "",
        s3Region: s3.region || "hel1",
        nzbServiceUrl: nzb.url || "",
        dockerImage: docker.downloader || "ghcr.io/ichbinder/openmedia-downloader:latest",
        usenetServers,
        vpnConfig,
        routingPolicy,
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

      // Resolve VPN config from vpn/uploadVpnProviderId config key
      const vpnConfig = await resolveVpnForProfile("uploadVpnProviderId");

      // Build routing policy for traffic guard
      const routingPolicy = buildRoutingPolicy(
        providers.map((p) => ({ host: p.host, port: p.port ?? 563 })),
        vpnConfig?.excludedCIDRs ?? null,
      );

      return {
        apiBaseUrl: runtime.api_base_url || "",
        s3AccessKey: s3.access_key || "",
        s3SecretKey: s3.secret_key || "",
        s3Endpoint: s3.endpoint || "",
        s3Bucket: s3.bucket || "",
        nzbServiceUrl: nzb.url || "",
        nzbServiceToken: nzb.token || "",
        dockerImage: docker.uploader || "ghcr.io/ichbinder/openmedia-uploader:latest",
        usenetProviders: providers,
        vpnConfig,
        routingPolicy,
      };
    }
  } catch (err) {
    console.warn(`[vps-config] DB config lookup failed: ${(err as Error).message}`);
  }

  return null;
}

// ─── VPN Resolution Helper ────────────────────────────────────────────

/**
 * Resolve VPN config from DB config keys.
 * Reads vpn/<providerIdKey> and vpn/bypassList, calls resolveVpnConfig().
 * Returns null if no provider is configured (R017).
 */
async function resolveVpnForProfile(providerIdKey: string): Promise<VpnConfigResolved | null> {
  try {
    const providerEntry = await getEntry("vpn", providerIdKey, false);
    if (!providerEntry || !providerEntry.value || providerEntry.value === "••••••••") {
      return null;
    }

    const providerId = providerEntry.value;

    // Parse bypass list (JSON array of {value: string} entries)
    let bypassEntries: VpnBypassEntry[] = [];
    try {
      const bypassEntry = await getEntry("vpn", "bypassList", false);
      if (bypassEntry && bypassEntry.value) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bypassEntry.value);
        } catch {
          // Legacy format: comma-separated string → convert to array
          parsed = bypassEntry.value.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
        if (Array.isArray(parsed)) {
          bypassEntries = parsed.map((item: string | VpnBypassEntry) =>
            typeof item === "string" ? { value: item } : item
          );
        }
      }
    } catch (err) {
      console.warn(`[vps-config] Failed to parse vpn/bypassList: ${(err as Error).message}`);
    }

    const vpnConfig = await resolveVpnConfig(providerId, bypassEntries);
    if (vpnConfig) {
      console.log(`[vps-config] VPN config resolved for provider ${vpnConfig.providerName} (${vpnConfig.protocol})`);
    }
    return vpnConfig;
  } catch (err) {
    console.warn(`[vps-config] VPN config resolution failed: ${(err as Error).message}`);
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Check if DB config has the minimum keys needed for download provisioning. */
function hasRequiredDownloadKeys(config: Record<string, Record<string, string>>): boolean {
  const s3 = config.s3;
  const nzb = config.nzb_service;
  const runtime = config.runtime;
  return !!(s3 && s3.access_key && s3.secret_key && s3.endpoint && s3.bucket &&
    nzb && nzb.url &&
    runtime && runtime.api_base_url);
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
    runtime && runtime.api_base_url);
}

// ─── VPS Limits (Concurrency Gate) ───────────────────────────────────

export interface VpsLimits {
  globalLimit: number;
  maxUploadVps: number;
}

export interface ActiveVpsCounts {
  downloads: number;
  uploads: number;
  total: number;
}

export interface CanProvisionResult {
  allowed: boolean;
  reason?: string;
  counts?: ActiveVpsCounts;
  limits?: VpsLimits;
}

const DEFAULT_GLOBAL_LIMIT = 10;
const DEFAULT_MAX_UPLOAD_VPS = 3;

/**
 * Read VPS limits from DB config store.
 * Falls back to defaults if config entries don't exist.
 */
export async function getVpsLimits(): Promise<VpsLimits> {
  let globalLimit = DEFAULT_GLOBAL_LIMIT;
  let maxUploadVps = DEFAULT_MAX_UPLOAD_VPS;

  try {
    const globalEntry = await getEntry("vps", "globalLimit", false);
    if (globalEntry?.value) {
      const parsed = parseInt(globalEntry.value, 10);
      if (!isNaN(parsed) && parsed >= 1) globalLimit = parsed;
    }

    const uploadEntry = await getEntry("vps", "maxUploadVps", false);
    if (uploadEntry?.value) {
      const parsed = parseInt(uploadEntry.value, 10);
      if (!isNaN(parsed) && parsed >= 0) maxUploadVps = parsed;
    }
  } catch (err) {
    console.warn(`[vps-config] Failed to read VPS limits from DB — using defaults: ${(err as Error).message}`);
  }

  // Clamp: upload max can't exceed global limit
  if (maxUploadVps > globalLimit) {
    maxUploadVps = globalLimit;
  }

  return { globalLimit, maxUploadVps };
}

/**
 * Count active VPS by type (jobs that have a hetznerServerId = VPS is running).
 */
export async function getActiveVpsCounts(): Promise<ActiveVpsCounts> {
  const [downloads, uploads] = await Promise.all([
    prisma.downloadJob.count({
      where: {
        hetznerServerId: { not: null },
        status: { in: ["provisioning", "downloading", "uploading"] },
      },
    }),
    prisma.uploadJob.count({
      where: {
        hetznerServerId: { not: null },
        status: { in: ["queued", "running"] },
      },
    }),
  ]);

  return { downloads, uploads, total: downloads + uploads };
}

/**
 * Check if a new VPS of the given type can be provisioned within limits.
 */
export async function canProvision(type: "download" | "upload"): Promise<CanProvisionResult> {
  const [limits, counts] = await Promise.all([
    getVpsLimits(),
    getActiveVpsCounts(),
  ]);

  // Global limit check
  if (counts.total >= limits.globalLimit) {
    return {
      allowed: false,
      reason: `Global VPS limit reached (${counts.total}/${limits.globalLimit})`,
      counts,
      limits,
    };
  }

  // Upload-specific limit check
  if (type === "upload" && counts.uploads >= limits.maxUploadVps) {
    return {
      allowed: false,
      reason: `Upload VPS limit reached (${counts.uploads}/${limits.maxUploadVps})`,
      counts,
      limits,
    };
  }

  // Download-specific: remaining slots after uploads are reserved
  if (type === "download") {
    const maxDownloadVps = limits.globalLimit - limits.maxUploadVps;
    if (counts.downloads >= maxDownloadVps) {
      return {
        allowed: false,
        reason: `Download VPS limit reached (${counts.downloads}/${maxDownloadVps})`,
        counts,
        limits,
      };
    }
  }

  return { allowed: true, counts, limits };
}

/**
 * Build a routing policy from usenet targets and VPN bypass CIDRs.
 * Returns null if no VPN config is present (no split-tunnel to enforce).
 */
function buildRoutingPolicy(
  usenetTargets: MustVpnTarget[],
  excludedCIDRs: string[] | null,
): RoutingPolicy | null {
  if (!excludedCIDRs) return null;

  return {
    mustVpn: usenetTargets,
    mustDirect: excludedCIDRs,
  };
}

// ─── Location Preferences (Datacenter Fallback) ──────────────────────

/**
 * Default ordered list of Hetzner locations to try when provisioning a VPS.
 * Helsinki first because the S3 bucket lives there; Falkenstein and Nuremberg
 * are EU-Central fallbacks with broad capacity.
 */
export const DEFAULT_VPS_LOCATIONS: readonly string[] = ["hel1", "fsn1", "nbg1"];

/**
 * Read an ordered location list from a vps/<key> JSON-array config entry.
 * Returns the default list if the entry is missing, malformed, or empty.
 */
async function getVpsLocationsFromKey(key: string): Promise<string[]> {
  try {
    const entry = await getEntry("vps", key, false);
    if (!entry?.value) return [...DEFAULT_VPS_LOCATIONS];

    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.value);
    } catch {
      console.warn(`[vps-config] vps/${key} is not valid JSON — using defaults`);
      return [...DEFAULT_VPS_LOCATIONS];
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...DEFAULT_VPS_LOCATIONS];
    }

    const cleaned = parsed
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());

    return cleaned.length > 0 ? cleaned : [...DEFAULT_VPS_LOCATIONS];
  } catch (err) {
    console.warn(`[vps-config] Failed to read vps/${key}: ${(err as Error).message}`);
    return [...DEFAULT_VPS_LOCATIONS];
  }
}

/** Ordered location preferences for download VPS provisioning. */
export async function getDownloadVpsLocations(): Promise<string[]> {
  return getVpsLocationsFromKey("downloadLocations");
}

/** Ordered location preferences for upload VPS provisioning. */
export async function getUploadVpsLocations(): Promise<string[]> {
  return getVpsLocationsFromKey("uploadLocations");
}
