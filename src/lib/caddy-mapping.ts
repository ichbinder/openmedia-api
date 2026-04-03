/**
 * Caddy Download-Client Mapping
 *
 * Manages the dl-backends.map file that Caddy uses to route
 * *.dl.mediatoken.de subdomains to download VPS private IPs.
 *
 * Format: one line per mapping — "<subdomain> <ip:port>"
 * Example: "dl-a1b2c3d4 10.0.0.3:8080"
 *
 * After each change the file is written and Caddy is reloaded
 * via `docker exec caddy caddy reload`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";

/** Path to the mapping file (shared volume between API and Caddy containers) */
const MAPPING_FILE = process.env.DL_MAPPING_FILE || "/data/dl-backends.map";

/** SABnzbd UI port inside the download container */
const SABNZBD_PORT = 8080;

// ---------------------------------------------------------------------------
// Map I/O
// ---------------------------------------------------------------------------

interface BackendMapping {
  subdomain: string;
  backend: string; // ip:port
}

function readMappings(): BackendMapping[] {
  try {
    const content = readFileSync(MAPPING_FILE, "utf-8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const [subdomain, backend] = line.split(/\s+/);
        return { subdomain, backend };
      })
      .filter((m) => m.subdomain && m.backend);
  } catch {
    return [];
  }
}

function writeMappings(mappings: BackendMapping[]): void {
  const header = [
    "# Download client backend mapping",
    "# Format: <subdomain> <private-ip:port>",
    "# Managed automatically by openmedia-api. Do not edit manually.",
    "",
  ].join("\n");

  const lines = mappings.map((m) => `${m.subdomain} ${m.backend}`);
  writeFileSync(MAPPING_FILE, header + lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Caddy Reload
// ---------------------------------------------------------------------------

function reloadCaddy(): Promise<void> {
  return new Promise((resolve) => {
    exec(
      "docker exec caddy caddy reload --config /etc/caddy/Caddyfile",
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[caddy-mapping] Reload failed: ${stderr || err.message}`);
          // Don't throw — the mapping file is already written, Caddy will pick it up on next restart
        } else {
          console.log("[caddy-mapping] Caddy reloaded successfully");
        }
        resolve();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a download client mapping.
 *
 * @param serverName  VPS name used as subdomain (e.g. "dl-a1b2c3d4")
 * @param privateIp   Private network IP of the VPS (e.g. "10.0.0.3")
 */
export async function addMapping(serverName: string, privateIp: string): Promise<void> {
  const mappings = readMappings();

  // Remove existing mapping for this subdomain (idempotent)
  const filtered = mappings.filter((m) => m.subdomain !== serverName);
  filtered.push({ subdomain: serverName, backend: `${privateIp}:${SABNZBD_PORT}` });

  writeMappings(filtered);
  console.log(`[caddy-mapping] Added: ${serverName} → ${privateIp}:${SABNZBD_PORT}`);

  await reloadCaddy();
}

/**
 * Remove a download client mapping.
 *
 * @param serverName  VPS name / subdomain to remove
 */
export async function removeMapping(serverName: string): Promise<void> {
  const mappings = readMappings();
  const filtered = mappings.filter((m) => m.subdomain !== serverName);

  if (filtered.length === mappings.length) {
    console.log(`[caddy-mapping] No mapping found for ${serverName} — nothing to remove`);
    return;
  }

  writeMappings(filtered);
  console.log(`[caddy-mapping] Removed: ${serverName}`);

  await reloadCaddy();
}

/**
 * List all current mappings.
 */
export function listMappings(): BackendMapping[] {
  return readMappings();
}

/**
 * Clean up mappings for VPS names that no longer exist.
 *
 * @param activeServerNames  Set of currently active VPS names
 */
export async function cleanupStaleMappings(activeServerNames: Set<string>): Promise<string[]> {
  const mappings = readMappings();
  const stale = mappings.filter((m) => !activeServerNames.has(m.subdomain));

  if (stale.length === 0) return [];

  const active = mappings.filter((m) => activeServerNames.has(m.subdomain));
  writeMappings(active);

  const removed = stale.map((m) => m.subdomain);
  console.log(`[caddy-mapping] Cleaned ${removed.length} stale mapping(s): ${removed.join(", ")}`);

  await reloadCaddy();
  return removed;
}
