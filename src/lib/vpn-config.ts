/**
 * VPN Config Resolution — resolves a VPN provider + bypass list into
 * a usable WireGuard configuration with Split-Tunnel AllowedIPs.
 *
 * Uses cidr-tools.excludeCidr() to compute AllowedIPs by excluding
 * bypass CIDRs from the full internet range (0.0.0.0/0).
 */

import { excludeCidr } from "cidr-tools";
import { resolve4, resolve6 } from "node:dns/promises";
import { getVpnProviderById } from "./vpn-provider-service.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface VpnBypassEntry {
  /** CIDR notation (e.g. "10.0.0.0/8") or hostname (e.g. "api.example.com") */
  value: string;
}

export interface VpnConfigResolved {
  providerId: string;
  providerName: string;
  protocol: string;
  /** The WireGuard config with AllowedIPs replaced for split-tunnel */
  configBlob: string;
  /** Computed AllowedIPs CIDRs after bypass exclusion */
  allowedIPs: string[];
  /** CIDRs that were excluded (bypass + defaults) */
  excludedCIDRs: string[];
  username: string | null;
  password: string | null;
}

// ─── Defaults ─────────────────────────────────────────────────────────

/** Always excluded from VPN tunnel (cloud metadata, private networks) */
const DEFAULT_BYPASS_CIDRS = [
  "169.254.169.254/32", // cloud instance metadata
  "10.0.0.0/8",         // private network (VPS management, internal services)
];

// ─── DNS Resolution ───────────────────────────────────────────────────

/**
 * Resolve a bypass list to CIDRs. Hostnames are DNS-resolved to IPs,
 * CIDR entries pass through directly. Failed DNS lookups are warned and skipped.
 */
export async function resolveBypassList(
  entries: VpnBypassEntry[]
): Promise<string[]> {
  const cidrs: string[] = [...DEFAULT_BYPASS_CIDRS];

  for (const entry of entries) {
    const val = entry.value.trim();
    if (!val) continue;

    // Already a CIDR or plain IP (IPv4 or IPv6)
    if (/^[\d.]+\/\d+$/.test(val) || /^[\d.]+$/.test(val)) {
      cidrs.push(val.includes("/") ? val : `${val}/32`);
      continue;
    }
    if (/^[0-9a-fA-F:]+\/\d+$/.test(val) || /^[0-9a-fA-F:]*:[0-9a-fA-F:]+$/.test(val)) {
      cidrs.push(val.includes("/") ? val : `${val}/128`);
      continue;
    }

    // Hostname — resolve via DNS (IPv4 first, IPv6 as fallback)
    let resolved = false;
    try {
      const ips = await resolve4(val);
      for (const ip of ips) {
        cidrs.push(`${ip}/32`);
      }
      resolved = true;
    } catch {
      // no IPv4 records — try IPv6 below
    }
    try {
      const ips6 = await resolve6(val);
      for (const ip of ips6) {
        cidrs.push(`${ip}/128`);
      }
      resolved = true;
    } catch {
      // no IPv6 records either
    }
    if (!resolved) {
      console.warn(
        `[vpn-config] DNS resolution failed for bypass host "${val}", skipping`
      );
    }
  }

  return cidrs;
}

// ─── AllowedIPs Calculation ───────────────────────────────────────────

/**
 * Calculate WireGuard AllowedIPs by excluding bypass CIDRs from the
 * full internet range. Uses cidr-tools.excludeCidr() for correct
 * CIDR arithmetic.
 */
export function calculateAllowedIPs(excludedCIDRs: string[]): string[] {
  if (excludedCIDRs.length === 0) {
    return ["0.0.0.0/0"];
  }

  // Include ::/0 as base when IPv6 bypass CIDRs are present,
  // so excludeCidr can compute correct IPv6 AllowedIPs too.
  const hasIPv6 = excludedCIDRs.some((c) => c.includes(":"));
  const base = hasIPv6 ? ["0.0.0.0/0", "::/0"] : ["0.0.0.0/0"];
  return excludeCidr(base, excludedCIDRs);
}

// ─── WireGuard Config Parsing ─────────────────────────────────────────

/**
 * Parse a WireGuard config and replace the AllowedIPs line in the [Peer]
 * section with the computed split-tunnel values.
 */
export function parseWireGuardConfig(
  configBlob: string,
  allowedIPs: string[]
): string {
  const allowedIPsValue = allowedIPs.join(", ");

  // Replace AllowedIPs in [Peer] section(s)
  // Match: AllowedIPs = <anything until end of line> (global: handles multiple peers)
  const replaced = configBlob.replace(
    /^(\s*AllowedIPs\s*=\s*)(.*)$/gm,
    `$1${allowedIPsValue}`
  );

  return replaced;
}

// ─── Main Resolution ──────────────────────────────────────────────────

/**
 * Resolve a VPN provider into a ready-to-use VPN configuration.
 *
 * Returns null if the provider doesn't exist or is disabled.
 * The returned configBlob has AllowedIPs replaced with computed
 * split-tunnel values based on the bypass list.
 */
export async function resolveVpnConfig(
  providerId: string,
  bypassEntries: VpnBypassEntry[] = []
): Promise<VpnConfigResolved | null> {
  // Load provider with decrypted config
  const provider = await getVpnProviderById(providerId, true);

  if (!provider) {
    return null;
  }

  if (!provider.enabled) {
    return null;
  }

  // Resolve bypass list (hostnames → IPs, add defaults)
  const excludedCIDRs = await resolveBypassList(bypassEntries);

  // Calculate AllowedIPs via CIDR exclusion
  const allowedIPs = calculateAllowedIPs(excludedCIDRs);

  // Pass through the original WireGuard config unchanged.
  // wg-quick needs AllowedIPs = 0.0.0.0/0 to set up correct policy routing
  // (fwmark). Replacing AllowedIPs with split-tunnel CIDRs causes a routing
  // loop to the VPN endpoint. Bypass routes are handled via iptables
  // kill-switch ACCEPT rules in the Cloud-Init instead.
  const resolvedConfig = provider.configBlob;

  return {
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    configBlob: resolvedConfig,
    allowedIPs,
    excludedCIDRs,
    username: provider.username,
    password: provider.password,
  };
}
