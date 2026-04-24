/**
 * Hetzner Cloud API Service — manages on-demand VPS for downloads.
 *
 * Configuration via environment variables:
 *   HETZNER_API_TOKEN — Hetzner Cloud API token (read/write)
 *
 * Servers are created with labels for tracking:
 *   purpose=openmedia-download, job-id={downloadJobId}
 *
 * All servers are created in HEL1 (Helsinki) to match the S3 bucket location.
 */

import type { VpnConfigResolved } from "./vpn-config.js";

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getToken(): string {
  return process.env.HETZNER_API_TOKEN || "";
}

/** Check if Hetzner Cloud API is configured. */
export function isHetznerConfigured(): boolean {
  return !!process.env.HETZNER_API_TOKEN;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HetznerServer {
  id: number;
  name: string;
  status: string; // initializing, starting, running, stopping, off, deleting, migrating, rebuilding, unknown
  publicIpv4: string | null;
  publicIpv6: string | null;
  privateIp: string | null;
  serverType: string;
  location: string;
  labels: Record<string, string>;
  created: string; // ISO timestamp
}

export interface HetznerCreateServerOptions {
  name: string;
  serverType?: string;     // default: cax21 (4 vCPU ARM, 8GB RAM)
  image?: string;          // default: docker-ce (Docker pre-installed)
  location?: string;       // default: hel1
  userData?: string;       // Cloud-Init script
  sshKeys?: string[];      // SSH key names
  labels?: Record<string, string>;
  networks?: number[];     // Private network IDs to attach
}

export interface HetznerCreateServerResult {
  server: HetznerServer;
  rootPassword: string | null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function hetznerFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getToken();
  if (!token) {
    throw new Error("HETZNER_API_TOKEN ist nicht konfiguriert.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${HETZNER_API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function mapServer(raw: any): HetznerServer {
  // Extract the first private network IP (if attached)
  const privateNet = Array.isArray(raw.private_net) && raw.private_net.length > 0
    ? raw.private_net[0]
    : null;

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    publicIpv4: raw.public_net?.ipv4?.ip || null,
    publicIpv6: raw.public_net?.ipv6?.ip || null,
    privateIp: privateNet?.ip || null,
    serverType: raw.server_type?.name || raw.server_type,
    location: raw.datacenter?.location?.name || raw.location,
    labels: raw.labels || {},
    created: raw.created,
  };
}

// ---------------------------------------------------------------------------
// Server Operations
// ---------------------------------------------------------------------------

/**
 * Create a new Hetzner Cloud server.
 *
 * Default config optimized for download workloads:
 * - cax21: 4 vCPU ARM, 8GB RAM, 80GB disk (upgraded from cax11 for faster S3 uploads)
 * - docker-ce: Ubuntu with Docker pre-installed
 * - hel1: Helsinki (same region as S3 bucket)
 */
export async function createServer(
  options: HetznerCreateServerOptions,
): Promise<HetznerCreateServerResult> {
  const start = Date.now();

  const body: Record<string, any> = {
    name: options.name,
    server_type: options.serverType || "cax21",
    image: options.image || "docker-ce",
    location: options.location || "hel1",
    labels: {
      purpose: "openmedia-download",
      ...options.labels,
    },
    start_after_create: true,
  };

  if (options.userData) {
    body.user_data = options.userData;
  }

  if (options.sshKeys && options.sshKeys.length > 0) {
    body.ssh_keys = options.sshKeys;
  }

  if (options.networks && options.networks.length > 0) {
    body.networks = options.networks;
  }

  const res = await hetznerFetch("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    const durationMs = Date.now() - start;
    console.error(`[hetzner] Create server failed (${durationMs}ms): ${res.status} — ${err?.error?.message || "unknown"}`);
    throw new Error(`Hetzner API: ${res.status} — ${err?.error?.message || "Server konnte nicht erstellt werden."}`);
  }

  const data: any = await res.json();
  const durationMs = Date.now() - start;

  const server = mapServer(data.server);
  console.log(`[hetzner] Server created: ${server.name} (id: ${server.id}, type: ${server.serverType}, location: ${server.location}) in ${durationMs}ms`);

  return {
    server,
    rootPassword: data.root_password || null,
  };
}

/**
 * Get server details by ID.
 */
export async function getServer(serverId: number): Promise<HetznerServer | null> {
  const res = await hetznerFetch(`/servers/${serverId}`);

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    throw new Error(`Hetzner API: ${res.status} — ${err?.error?.message || "Server nicht abrufbar."}`);
  }

  const data: any = await res.json();
  return mapServer(data.server);
}

/**
 * Delete a server by ID.
 */
export async function deleteServer(serverId: number): Promise<boolean> {
  const start = Date.now();

  const res = await hetznerFetch(`/servers/${serverId}`, {
    method: "DELETE",
  });

  const durationMs = Date.now() - start;

  if (res.status === 404) {
    console.log(`[hetzner] Server ${serverId} already deleted (${durationMs}ms)`);
    return false;
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    console.error(`[hetzner] Delete server ${serverId} failed (${durationMs}ms): ${res.status} — ${err?.error?.message || "unknown"}`);
    throw new Error(`Hetzner API: ${res.status} — ${err?.error?.message || "Server konnte nicht gelöscht werden."}`);
  }

  console.log(`[hetzner] Server ${serverId} deleted (${durationMs}ms)`);
  return true;
}

/**
 * List servers filtered by label selector.
 *
 * @param labelSelector  Hetzner label selector (e.g. "purpose=openmedia-download")
 */
export async function listServers(
  labelSelector?: string,
): Promise<HetznerServer[]> {
  const params = new URLSearchParams();
  if (labelSelector) {
    params.set("label_selector", labelSelector);
  }
  params.set("per_page", "50");

  const res = await hetznerFetch(`/servers?${params}`);

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any;
    throw new Error(`Hetzner API: ${res.status} — ${err?.error?.message || "Server-Liste nicht abrufbar."}`);
  }

  const data: any = await res.json();
  return (data.servers || []).map(mapServer);
}

/**
 * Find zombie servers — download servers that have been running longer than maxAgeHours.
 *
 * These are servers that should have been cleaned up but weren't (e.g. post-processing
 * script crashed, API callback failed, etc.)
 */
export async function findZombieServers(
  maxAgeHours: number = 6,
): Promise<HetznerServer[]> {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;

  // Check both download and upload VPS instances
  const [downloadServers, uploadServers] = await Promise.all([
    listServers("purpose=openmedia-download"),
    listServers("purpose=openmedia-upload"),
  ]);
  const servers = [...downloadServers, ...uploadServers];

  return servers.filter((s) => {
    const created = new Date(s.created).getTime();
    return created < cutoff && s.status !== "deleting";
  });
}

/**
 * Clean up zombie servers — delete all servers older than maxAgeHours.
 *
 * @returns Array of deleted server IDs
 */
export async function cleanupZombieServers(
  maxAgeHours: number = 6,
): Promise<number[]> {
  const zombies = await findZombieServers(maxAgeHours);

  if (zombies.length === 0) {
    console.log("[hetzner] No zombie servers found.");
    return [];
  }

  console.log(`[hetzner] Found ${zombies.length} zombie server(s). Cleaning up...`);

  const deletedIds: number[] = [];
  for (const server of zombies) {
    try {
      const deleted = await deleteServer(server.id);
      if (deleted) {
        deletedIds.push(server.id);
        console.log(`[hetzner] Zombie cleaned: ${server.name} (id: ${server.id}, age: ${server.created})`);
      }
    } catch (err: any) {
      console.error(`[hetzner] Failed to clean zombie ${server.id}: ${err.message}`);
    }
  }

  return deletedIds;
}

// ---------------------------------------------------------------------------
// Cloud-Init Template
// ---------------------------------------------------------------------------

/**
 * Generate a Cloud-Init script for a download VPS.
 *
 * The VPS receives only 3 ENV vars: JOB_ID, API_BASE_URL, SERVICE_TOKEN.
 * All other config (S3, Usenet, NZB URL) is fetched at boot via the
 * /service/jobs/:id/bootstrap API endpoint using the SERVICE_TOKEN.
 */
/** Usenet server configuration for SABnzbd */
export interface UsenetServer {
  host: string;
  port?: number;
  username: string;
  password: string;
  ssl?: boolean;
  connections?: number;
  optional?: number;
  priority?: number;
}

/**
 * Generate the VPN watchdog bash script that monitors connectivity and
 * reconnects with exponential backoff (5s/15s/30s). After 3 failed
 * reconnect cycles the watchdog PATCHes the job to "failed" and exits.
 * Self-terminates when the main docker workload is no longer running.
 */
function generateVpnWatchdog(
  vpnConfig: VpnConfigResolved,
  apiBaseUrl: string,
  serviceToken: string,
  jobId: string,
  jobEndpointPath: string,
): string {
  const vpnInterface = vpnConfig.protocol === "openvpn" ? "tun0" : "wg0";

  const reconnectCmd =
    vpnConfig.protocol === "openvpn"
      ? `    killall -9 openvpn 2>/dev/null || true
    sleep 1
    openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log
    # Wait for tun0 to come back (up to 30s)
    for j in $(seq 1 30); do
      ip link show tun0 > /dev/null 2>&1 && break
      sleep 1
    done`
      : `    wg-quick down wg0 2>/dev/null || true
    wg-quick up wg0`;

  return `#!/usr/bin/env bash
set -euo pipefail

# VPN Watchdog — reconnect with backoff (R018), fail after 3 attempts (R019)

API_BASE_URL="${apiBaseUrl}"
SERVICE_TOKEN="${serviceToken}"
JOB_ID="${jobId}"
JOB_ENDPOINT_PATH="${jobEndpointPath}"
VPN_INTERFACE="${vpnInterface}"

BACKOFF_DELAYS=(5 15 30)
MAX_RETRIES=3
CHECK_INTERVAL=10

watchdog_fail_job() {
  local msg="\$1"
  echo "[vpn-watchdog] FATAL: \$msg"
  curl -sf -X PATCH "\${API_BASE_URL}\${JOB_ENDPOINT_PATH}" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"status\\":\\"failed\\",\\"error\\":\\"\$msg\\"}" || true
}

reconnect_vpn() {
${reconnectCmd}
}

health_check() {
  # Two-pronged check:
  # 1. VPN tunnel is alive (external connectivity through VPN interface)
  # 2. API is reachable (may go through private network, not through VPN)
  curl -sf --interface "\$VPN_INTERFACE" --connect-timeout 5 "https://api.ipify.org" > /dev/null 2>&1 \\
    && curl -sf --connect-timeout 5 "\${API_BASE_URL}/health" > /dev/null 2>&1
}

echo "[vpn-watchdog] Started — monitoring \$VPN_INTERFACE every \${CHECK_INTERVAL}s"

SEEN_WORKLOAD=0

while true; do
  sleep "\$CHECK_INTERVAL"

  # Self-termination: exit if no docker containers are running — but only after
  # at least one container was seen, to avoid exiting before docker images start
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q .; then
    SEEN_WORKLOAD=1
  elif [ "\$SEEN_WORKLOAD" = "1" ]; then
    echo "[vpn-watchdog] No running containers — exiting"
    exit 0
  fi

  # Health check
  if health_check; then
    continue
  fi

  echo "[vpn-watchdog] Health check failed — starting reconnect sequence"

  RECONNECTED=0
  for attempt in $(seq 0 $((MAX_RETRIES - 1))); do
    delay=\${BACKOFF_DELAYS[\$attempt]}
    echo "[vpn-watchdog] Reconnect attempt $((attempt + 1))/$MAX_RETRIES (backoff: \${delay}s)"
    sleep "\$delay"

    reconnect_vpn

    # Verify reconnect
    sleep 2
    if health_check; then
      echo "[vpn-watchdog] Reconnected successfully on attempt $((attempt + 1))"
      RECONNECTED=1
      break
    fi
  done

  if [ "\$RECONNECTED" = "0" ]; then
    watchdog_fail_job "VPN reconnect exhausted after $MAX_RETRIES attempts"
    exit 1
  fi
done
`;
}

/**
 * Generate cloud-init write_files + runcmd blocks for WireGuard VPN setup.
 * Includes iptables/ip6tables kill-switch and connectivity verification.
 * Returns empty strings if vpnConfig is null (R017: no VPN → unchanged cloud-init).
 */
function generateVpnWriteFiles(
  vpnConfig: VpnConfigResolved | null,
  watchdogParams?: { apiBaseUrl: string; serviceToken: string; jobId: string; jobEndpointPath: string },
): string {
  if (!vpnConfig) return "";

  if (vpnConfig.protocol === "openvpn") {
    // Prepare config blob: inject auth-user-pass directive if credentials present
    let configBlob = vpnConfig.configBlob;
    const hasCredentials = vpnConfig.username && vpnConfig.password;

    if (hasCredentials) {
      // Replace existing auth-user-pass line or append if not present
      if (/^\s*auth-user-pass\b/m.test(configBlob)) {
        configBlob = configBlob.replace(
          /^\s*auth-user-pass\b.*$/m,
          "auth-user-pass /etc/openvpn/auth.txt"
        );
      } else {
        configBlob = configBlob.trimEnd() + "\nauth-user-pass /etc/openvpn/auth.txt\n";
      }
    } else {
      // No credentials — remove any existing auth-user-pass directive
      // to prevent OpenVPN from prompting for credentials interactively
      configBlob = configBlob.replace(/^\s*auth-user-pass\b.*\n?/m, "");
    }

    const confBase64 = Buffer.from(configBlob).toString("base64");

    let files = `
  - path: /etc/openvpn/client.conf
    permissions: "0600"
    encoding: b64
    content: ${confBase64}`;

    if (hasCredentials) {
      const authContent = `${vpnConfig.username}\n${vpnConfig.password}`;
      const authBase64 = Buffer.from(authContent).toString("base64");
      files += `
  - path: /etc/openvpn/auth.txt
    permissions: "0600"
    encoding: b64
    content: ${authBase64}`;
    }

    if (watchdogParams) {
      const watchdogScript = generateVpnWatchdog(
        vpnConfig,
        watchdogParams.apiBaseUrl,
        watchdogParams.serviceToken,
        watchdogParams.jobId,
        watchdogParams.jobEndpointPath,
      );
      const watchdogBase64 = Buffer.from(watchdogScript).toString("base64");
      // 0700: script embeds SERVICE_TOKEN — must not be world-readable
      files += `
  - path: /opt/vpn-watchdog.sh
    permissions: "0700"
    encoding: b64
    content: ${watchdogBase64}`;
    }

    return files;
  }

  // WireGuard (default)
  const confBase64 = Buffer.from(vpnConfig.configBlob).toString("base64");

  let wgFiles = `
  - path: /etc/wireguard/wg0.conf
    permissions: "0600"
    encoding: b64
    content: ${confBase64}`;

  if (watchdogParams) {
    const watchdogScript = generateVpnWatchdog(
      vpnConfig,
      watchdogParams.apiBaseUrl,
      watchdogParams.serviceToken,
      watchdogParams.jobId,
      watchdogParams.jobEndpointPath,
    );
    const watchdogBase64 = Buffer.from(watchdogScript).toString("base64");
    // 0700: script embeds SERVICE_TOKEN — must not be world-readable
    wgFiles += `
  - path: /opt/vpn-watchdog.sh
    permissions: "0700"
    encoding: b64
    content: ${watchdogBase64}`;
  }

  return wgFiles;
}

function generateVpnRuncmd(vpnConfig: VpnConfigResolved | null, failJobRef: string): string {
  if (!vpnConfig) return "";

  if (vpnConfig.protocol === "openvpn") {
    // Parse remote server IP from OpenVPN config: "remote <host> <port>"
    const remoteMatch = vpnConfig.configBlob.match(/^\s*remote\s+(\S+)/m);
    const remoteHost = remoteMatch ? remoteMatch[1] : "";
    const remoteIsIPv6 = remoteHost.includes(":");

    // Build bypass routes for excludedCIDRs (IPv4 and IPv6)
    // Each CIDR also needs an iptables ACCEPT rule BEFORE the DROP rule so that
    // the kill-switch does not block the bypassed traffic.
    const bypassRoutes = vpnConfig.excludedCIDRs
      .map((cidr) => {
        const isIPv6 = cidr.includes(":");
        const cmd = isIPv6 ? `ip -6 route add` : `ip route add`;
        const gw = isIPv6 ? `$ORIG_GW6` : `$ORIG_GW`;
        const iptCmd = isIPv6 ? `ip6tables` : `iptables`;
        return [
          `    ${iptCmd} -I OUTPUT 1 -d ${cidr} -j ACCEPT`,
          `    if ! ${cmd} ${cidr} via ${gw} dev eth0; then echo "[vpn] Warning: bypass route failed for ${cidr}"; fi`,
        ].join("\n");
      })
      .join("\n");

    return `
    # ── VPN Setup (OpenVPN + Kill-Switch) ─────────────────────────────
    echo "[vpn] Updating package lists..."
    apt-get update -qq > /dev/null 2>&1
    echo "[vpn] Installing openvpn..."
    if ! timeout 60 apt-get install -y openvpn > /dev/null 2>&1; then
      ${failJobRef} "VPN setup failed: apt install openvpn timed out or failed"
      exit 1
    fi

    # Capture default gateways before tunnel overwrites them
    ORIG_GW=$(ip route show default | awk '{print $3}')
    ORIG_GW6=$(ip -6 route show default | awk '{print $3}')

    # iptables kill-switch: DROP all non-VPN traffic (R014)
    # Allow loopback
    iptables -A OUTPUT -o lo -j ACCEPT
    # Allow traffic to OpenVPN remote server (needed to establish tunnel)
    ${remoteHost && !remoteIsIPv6 ? `iptables -A OUTPUT -d ${remoteHost} -j ACCEPT` : "# No IPv4 remote parsed — skip iptables remote allow rule"}
    # Allow traffic through VPN interface
    iptables -A OUTPUT -o tun0 -j ACCEPT
    # Allow established connections (for responses)
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    # Allow DHCP/cloud-init metadata
    iptables -A OUTPUT -d 169.254.169.254/32 -j ACCEPT
    # Allow private network (VPS management)
    iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
    # DROP everything else
    iptables -A OUTPUT -j DROP

    # ip6tables kill-switch: block all IPv6 to prevent leaks (allow VPN interface)
    ip6tables -A OUTPUT -o lo -j ACCEPT
    ip6tables -A OUTPUT -o tun0 -j ACCEPT
    # Allow traffic to OpenVPN remote if it is an IPv6 address
    ${remoteHost && remoteIsIPv6 ? `ip6tables -A OUTPUT -d ${remoteHost} -j ACCEPT` : "# No IPv6 remote — skip ip6tables remote allow rule"}
    ip6tables -A OUTPUT -j DROP

    echo "[vpn] Kill-switch active (iptables + ip6tables)"

    # Start OpenVPN daemon
    openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log

    # Wait for tun0 interface (up to 30s)
    echo "[vpn] Waiting for tun0 interface..."
    TUN_UP=0
    for i in $(seq 1 30); do
      if ip link show tun0 > /dev/null 2>&1; then
        TUN_UP=1
        break
      fi
      sleep 1
    done
    if [ "$TUN_UP" = "0" ]; then
      echo "[vpn] OpenVPN log:"
      cat /var/log/openvpn.log 2>/dev/null || true
      ${failJobRef} "VPN setup failed: tun0 not up after 30s"
      exit 1
    fi

    echo "[vpn] OpenVPN tunnel up (tun0)"

    # Bypass routes: route excludedCIDRs via original gateway
${bypassRoutes}

    # DNS leak fix
    echo 'nameserver 1.1.1.1' > /etc/resolv.conf

    # Verify VPN connectivity (check that traffic routes through tunnel)
    # Verify VPN connectivity — use IP-based check (DNS may not resolve yet through tunnel)
    sleep 3
    VPN_OK=0
    for i in 1 2 3; do
      if timeout 10 curl -sf --interface tun0 http://1.1.1.1/cdn-cgi/trace > /dev/null 2>&1; then
        VPN_OK=1
        break
      fi
      echo "[vpn] Connectivity check attempt $i failed, retrying..."
      sleep 3
    done
    if [ "$VPN_OK" = "0" ]; then
      ${failJobRef} "VPN setup failed: connectivity check through tun0 failed after 3 attempts"
      exit 1
    fi

    echo "[vpn] Connectivity verified through tun0"

    # Start VPN watchdog (reconnect with backoff, R018/R019)
    chmod +x /opt/vpn-watchdog.sh
    nohup /opt/vpn-watchdog.sh > /var/log/vpn-watchdog.log 2>&1 &
    # ── End VPN Setup ─────────────────────────────────────────────────
`;
  }

  // WireGuard (default)
  // Parse WireGuard endpoint IP from config for iptables ALLOW rule.
  // IPv6 endpoints are bracketed: "[2001:db8::1]:51820" — strip brackets.
  // IPv4/hostname endpoints: "1.2.3.4:51820"
  const endpointLineMatch = vpnConfig.configBlob.match(/^\s*Endpoint\s*=\s*(.+)/m);
  const endpointRaw = endpointLineMatch ? endpointLineMatch[1].trim() : "";
  // Bracketed IPv6: [addr]:port → extract addr
  const ipv6BracketMatch = endpointRaw.match(/^\[([^\]]+)\]/);
  const endpointHost = ipv6BracketMatch
    ? ipv6BracketMatch[1]
    : endpointRaw.replace(/:(\d+)$/, ""); // strip :port from IPv4/hostname
  const endpointIsIPv6 = endpointHost.includes(":");

  // iptables ALLOW rule (IPv4 only; ip6tables handled separately below)
  const endpointAllowRule = endpointHost && !endpointIsIPv6
    ? `iptables -A OUTPUT -d ${endpointHost} -j ACCEPT`
    : "# No IPv4 endpoint parsed — skip iptables endpoint allow rule";

  // ip6tables ALLOW rule for IPv6 endpoint
  const endpointAllowRuleIPv6 = endpointHost && endpointIsIPv6
    ? `ip6tables -A OUTPUT -d ${endpointHost} -j ACCEPT`
    : "# No IPv6 endpoint — skip ip6tables endpoint allow rule";

  // Build ACCEPT rules for excludedCIDRs so the kill-switch does not block
  // bypassed traffic (e.g. cloud metadata, private networks, custom bypasses).
  // IPv4 CIDRs → iptables, IPv6 CIDRs → ip6tables.
  const excludedCIDRAcceptRules = vpnConfig.excludedCIDRs
    .map((cidr) => {
      const isIPv6 = cidr.includes(":");
      const cmd = isIPv6 ? "ip6tables" : "iptables";
      return `    ${cmd} -I OUTPUT 1 -d ${cidr} -j ACCEPT`;
    })
    .join("\n");

  // Build bypass routes for excludedCIDRs — route them via original gateway
  // instead of through the WireGuard tunnel. Without these, wg-quick's fwmark
  // policy routing (table 51820) sends ALL traffic through wg0.
  const excludedCIDRBypassRoutes = vpnConfig.excludedCIDRs
    .map((cidr) => {
      const isIPv6 = cidr.includes(":");
      const cmd = isIPv6 ? "ip -6 route add" : "ip route add";
      const gw = isIPv6 ? "$ORIG_GW6" : "$ORIG_GW";
      const dev = isIPv6 ? "${ORIG_DEV6:-$ORIG_DEV}" : "$ORIG_DEV";
      return `    if ! ${cmd} ${cidr} via ${gw} dev ${dev}; then echo "[vpn] Warning: bypass route failed for ${cidr}"; fi`;
    })
    .join("\n");

  return `
    # ── VPN Setup (WireGuard + Kill-Switch) ──────────────────────────
    echo "[vpn] Updating package lists..."
    apt-get update -qq > /dev/null 2>&1
    echo "[vpn] Installing wireguard-tools..."
    if ! timeout 60 apt-get install -y wireguard-tools > /dev/null 2>&1; then
      ${failJobRef} "VPN setup failed: apt install wireguard-tools timed out or failed"
      exit 1
    fi

    # Capture default gateway and interface before wg-quick overwrites routing
    ORIG_GW=$(ip route show default | awk '{print $3}')
    ORIG_DEV=$(ip route show default | awk '{print $5}')
    ORIG_GW6=$(ip -6 route show default 2>/dev/null | awk '{print $3}')
    ORIG_DEV6=$(ip -6 route show default 2>/dev/null | awk '{print $5}')
    echo "[vpn] Default gateway: $ORIG_GW via $ORIG_DEV"

    # iptables kill-switch: DROP all non-VPN traffic (R014)
    # Allow loopback
    iptables -A OUTPUT -o lo -j ACCEPT
    # Allow traffic to WireGuard endpoint (needed to establish tunnel)
    ${endpointAllowRule}
    # Allow traffic through VPN interface
    iptables -A OUTPUT -o wg0 -j ACCEPT
    # Allow established connections (for responses)
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    # Allow DHCP/cloud-init metadata
    iptables -A OUTPUT -d 169.254.169.254/32 -j ACCEPT
    # Allow private network (VPS management)
    iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
    # DROP everything else
    iptables -A OUTPUT -j DROP

    # ip6tables kill-switch: block all IPv6 to prevent leaks (allow VPN interface)
    ip6tables -A OUTPUT -o lo -j ACCEPT
    ip6tables -A OUTPUT -o wg0 -j ACCEPT
    # Allow traffic to WireGuard endpoint if it is an IPv6 address
    ${endpointAllowRuleIPv6}
    ip6tables -A OUTPUT -j DROP

    # Bypass ACCEPT rules for excludedCIDRs (inserted at top of OUTPUT chain)
${excludedCIDRAcceptRules}

    echo "[vpn] Kill-switch active (iptables + ip6tables)"

    # Bring up WireGuard tunnel
    if ! timeout 30 wg-quick up wg0; then
      ${failJobRef} "VPN setup failed: wg-quick up wg0 failed"
      exit 1
    fi

    echo "[vpn] WireGuard tunnel up"

    # Bypass routes: route excludedCIDRs via original gateway (not through wg0)
    # Without these, wg-quick's fwmark policy routing sends ALL traffic through the tunnel.
${excludedCIDRBypassRoutes}

    # Verify VPN connectivity — use IP-based check (DNS may not resolve yet through tunnel)
    sleep 3
    VPN_OK=0
    for i in 1 2 3; do
      if timeout 10 curl -sf --interface wg0 http://1.1.1.1/cdn-cgi/trace > /dev/null 2>&1; then
        VPN_OK=1
        break
      fi
      echo "[vpn] Connectivity check attempt $i failed, retrying..."
      sleep 3
    done
    if [ "$VPN_OK" = "0" ]; then
      ${failJobRef} "VPN setup failed: connectivity check through wg0 failed after 3 attempts"
      exit 1
    fi

    echo "[vpn] Connectivity verified through wg0"

    # Start VPN watchdog (reconnect with backoff, R018/R019)
    chmod +x /opt/vpn-watchdog.sh
    nohup /opt/vpn-watchdog.sh > /var/log/vpn-watchdog.log 2>&1 &
    # ── End VPN Setup ────────────────────────────────────────────────
`;
}

/**
 * Generate a traffic monitoring script that logs which connections go through
 * the VPN tunnel (wg0/tun0) vs direct (eth0). Runs in background, writes to
 * /var/log/traffic-monitor.log. Temporary — for split-tunnel verification.
 */
function generateTrafficMonitorScript(): string {
  return `#!/bin/bash
# Traffic Monitor — logs all outbound connections with interface routing
# Writes to /var/log/traffic-monitor.log
set +e
LOG=/var/log/traffic-monitor.log

echo "=== TRAFFIC MONITOR STARTED $(date -u) ===" > "$LOG"
echo "" >> "$LOG"

# Log initial routing table
echo "--- ROUTING TABLE ---" >> "$LOG"
ip route show >> "$LOG" 2>&1
echo "" >> "$LOG"
echo "--- IP RULES ---" >> "$LOG"
ip rule show >> "$LOG" 2>&1
echo "" >> "$LOG"
echo "--- IPTABLES OUTPUT CHAIN ---" >> "$LOG"
iptables -L OUTPUT -n -v --line-numbers >> "$LOG" 2>&1
echo "" >> "$LOG"
echo "--- INTERFACES ---" >> "$LOG"
ip -br addr show >> "$LOG" 2>&1
echo "" >> "$LOG"

# Resolve known service IPs for labeling
resolve_dest() {
  local ip=\\$1
  local port=\\$2
  case "\\$port" in
    443|563) ;;  # SSL/NNTP-SSL
    119)     ;;  # NNTP
    *)       ;;
  esac
  # Check if destination matches known services
  if echo "\\$ip" | grep -qE "^10\\\\."; then
    echo "PRIVATE-NET"
  elif echo "\\$ip" | grep -qE "^169\\\\.254\\\\."; then
    echo "METADATA"
  else
    # Try reverse DNS (timeout 1s)
    local name
    name=\\$(timeout 1 dig +short -x "\\$ip" 2>/dev/null | head -1)
    if [ -n "\\$name" ]; then
      echo "\\$name"
    else
      echo "UNKNOWN"
    fi
  fi
}

# Classify interface for a destination IP
get_route_interface() {
  local ip=\\$1
  ip route get "\\$ip" 2>/dev/null | head -1
}

# Main monitoring loop
ITERATION=0
while true; do
  ITERATION=\\$((ITERATION + 1))
  echo "" >> "$LOG"
  echo "--- SNAPSHOT #\\$ITERATION $(date -u) ---" >> "$LOG"

  # Conntrack-based: show all established connections with source interface info
  if command -v conntrack > /dev/null 2>&1; then
    echo "[conntrack] Established connections:" >> "$LOG"
    conntrack -L -o extended 2>/dev/null | grep -E "ESTABLISHED|ASSURED" | while read -r line; do
      # Extract dst IP and dport
      dst=\\$(echo "\\$line" | grep -oP 'dst=\\K[0-9.]+' | head -1)
      dport=\\$(echo "\\$line" | grep -oP 'dport=\\K[0-9]+' | head -1)
      if [ -n "\\$dst" ] && [ -n "\\$dport" ]; then
        route_info=\\$(get_route_interface "\\$dst")
        label=\\$(resolve_dest "\\$dst" "\\$dport")
        echo "  \\$dst:\\$dport [\\$label] → route: \\$route_info" >> "$LOG"
      fi
    done 2>/dev/null
  fi

  # ss-based: show all TCP connections with process info
  echo "[ss] Active TCP connections:" >> "$LOG"
  ss -tunp state established 2>/dev/null | tail -n +2 | while read -r proto recvq sendq local peer process; do
    peer_ip=\\$(echo "\\$peer" | sed 's/:.*//')
    peer_port=\\$(echo "\\$peer" | sed 's/.*://')
    if [ -n "\\$peer_ip" ] && [ "\\$peer_ip" != "*" ]; then
      route_info=\\$(get_route_interface "\\$peer_ip")
      label=\\$(resolve_dest "\\$peer_ip" "\\$peer_port")
      echo "  \\$peer_ip:\\$peer_port [\\$label] proc=\\$process → route: \\$route_info" >> "$LOG"
    fi
  done

  # iptables packet counters — how much traffic on each rule
  echo "[iptables] Packet counts:" >> "$LOG"
  iptables -L OUTPUT -n -v --line-numbers 2>/dev/null | grep -E "(ACCEPT|DROP)" >> "$LOG"

  # Interface traffic counters
  echo "[ifstat] Interface bytes:" >> "$LOG"
  for iface in eth0 wg0 tun0; do
    if [ -d "/sys/class/net/\\$iface" ]; then
      rx=\\$(cat /sys/class/net/\\$iface/statistics/rx_bytes 2>/dev/null || echo 0)
      tx=\\$(cat /sys/class/net/\\$iface/statistics/tx_bytes 2>/dev/null || echo 0)
      rx_mb=\\$((rx / 1048576))
      tx_mb=\\$((tx / 1048576))
      echo "  \\$iface: RX=\\$rx_mbMB TX=\\$tx_mbMB" >> "$LOG"
    fi
  done

  # Check if downloader container is still running
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q openmedia-downloader; then
    echo "" >> "$LOG"
    echo "=== CONTAINER STOPPED — FINAL SUMMARY ===" >> "$LOG"
    echo "" >> "$LOG"

    # Final interface stats
    echo "--- FINAL INTERFACE TRAFFIC ---" >> "$LOG"
    for iface in eth0 wg0 tun0; do
      if [ -d "/sys/class/net/\\$iface" ]; then
        rx=\\$(cat /sys/class/net/\\$iface/statistics/rx_bytes 2>/dev/null || echo 0)
        tx=\\$(cat /sys/class/net/\\$iface/statistics/tx_bytes 2>/dev/null || echo 0)
        rx_mb=\\$((rx / 1048576))
        tx_mb=\\$((tx / 1048576))
        echo "  \\$iface: RX=\\$rx_mbMB TX=\\$tx_mbMB (total)" >> "$LOG"
      fi
    done

    echo "" >> "$LOG"
    echo "--- FINAL IPTABLES COUNTERS ---" >> "$LOG"
    iptables -L OUTPUT -n -v --line-numbers >> "$LOG" 2>&1
    echo "" >> "$LOG"
    echo "=== TRAFFIC MONITOR ENDED $(date -u) ===" >> "$LOG"
    exit 0
  fi

  sleep 30
done
`;
}

export function generateCloudInit(params: {
  jobId: string;
  apiBaseUrl: string;
  serviceToken: string;
  dockerImage: string;
  serverName: string;
  vpnConfig?: VpnConfigResolved | null;
}): string {
  // Build env file content — only 3 config vars, rest fetched at boot
  const envLines = [
    `JOB_ID=${params.jobId}`,
    `API_BASE_URL=${params.apiBaseUrl}`,
    `SERVICE_TOKEN=${params.serviceToken}`,
  ];

  const envContent = envLines.join("\n");

  // Base64-encode the env content to avoid YAML parsing issues
  const envBase64 = Buffer.from(envContent).toString("base64");

  const vpnConfig = params.vpnConfig ?? null;
  const vpnWriteFiles = generateVpnWriteFiles(vpnConfig, vpnConfig ? {
    apiBaseUrl: params.apiBaseUrl,
    serviceToken: params.serviceToken,
    jobId: params.jobId,
    jobEndpointPath: `/downloads/jobs/${params.jobId}/status`,
  } : undefined);
  const vpnRuncmd = generateVpnRuncmd(vpnConfig, "fail_job");

  // Traffic monitor script — logs all connections with interface routing info
  const trafficMonitorScript = generateTrafficMonitorScript();
  const trafficMonitorBase64 = Buffer.from(trafficMonitorScript).toString("base64");
  const trafficMonitorWriteFile = `
  - path: /opt/traffic-monitor.sh
    permissions: "0700"
    encoding: b64
    content: ${trafficMonitorBase64}`;

  return `#cloud-config
package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}${vpnWriteFiles}${trafficMonitorWriteFile}

runcmd:
  - |
    set -e

    # Source the env file for use in this script
    set -a
    . /opt/openmedia-env
    set +a

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/status" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }
${vpnRuncmd}
    # Install conntrack and start traffic monitor in background
    apt-get install -y -qq conntrack > /dev/null 2>&1 || true
    nohup /opt/traffic-monitor.sh > /dev/null 2>&1 &
    echo "[traffic-monitor] Started in background"

    if ! docker pull "${params.dockerImage}"; then
      fail_job "Docker pull failed: ${params.dockerImage}"
      exit 1
    fi

    if ! docker run -d --name openmedia-downloader \\
      -p 8080:8080 \\
      --env-file /opt/openmedia-env \\
      "${params.dockerImage}"; then
      fail_job "Docker run failed"
      exit 1
    fi

    # Wait for SABnzbd to start, then launch submit-and-monitor
    sleep 30
    if ! docker exec -d openmedia-downloader /bin/bash -c "/opt/openmedia/submit-and-monitor.sh > /var/log/submit-monitor.log 2>&1"; then
      fail_job "submit-and-monitor dispatch failed"
      exit 1
    fi

    # Verify the script actually started (docker exec -d only checks dispatch).
    # Retry loop: the script may need a few seconds to appear in the process list.
    VERIFY_OK=0
    for i in 1 2 3 4 5 6; do
      sleep 5
      if docker exec openmedia-downloader pgrep -f "submit-and-monitor" > /dev/null 2>&1; then
        VERIFY_OK=1
        break
      fi
    done
    if [ "$VERIFY_OK" = "0" ]; then
      fail_job "submit-and-monitor process not running after 30s"
      exit 1
    fi

  - |
    EXIT_CODE=$(docker wait openmedia-downloader)
    echo "openmedia-downloader exited with code $EXIT_CODE"
    docker logs openmedia-downloader > /var/log/openmedia-downloader.log 2>&1

    # Stop traffic monitor and print summary
    pkill -f traffic-monitor.sh 2>/dev/null || true
    sleep 2
    echo "========== TRAFFIC MONITOR LOG =========="
    cat /var/log/traffic-monitor.log 2>/dev/null || echo "(no traffic log)"
    echo "========== END TRAFFIC MONITOR =========="

    # === TEMPORARY: Skip self-cleanup so we can inspect traffic logs ===
    echo "[debug] VPS NOT self-deleting — traffic monitor inspection mode"
    echo "[debug] Traffic log at /var/log/traffic-monitor.log"

    # Install SSH key from openmedia-prod for remote access
    mkdir -p /root/.ssh
    echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINBgWCc4qgPhDC72FxLJIIKbeHS39yv3/dbTFwon062a root@openmedia-prod" >> /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys

    rm -f /opt/openmedia-env
`;
}

// ---------------------------------------------------------------------------
// Upload VPS provisioning
// ---------------------------------------------------------------------------

export interface GenerateUploadCloudInitParams {
  jobId: string;
  apiBaseUrl: string;
  serviceToken: string;
  dockerImage?: string;
  serverName: string;
  vpnConfig?: VpnConfigResolved | null;
}

export interface ProvisionUploadVpsParams {
  jobId: string;
  nzbFileHash: string;
  apiBaseUrl: string;
  serviceToken: string;
  dockerImage?: string;
  serverName: string;
  vpnConfig?: VpnConfigResolved | null;
}

/**
 * Generate cloud-init for an ephemeral upload VPS.
 * Similar to generateCloudInit but for the upload pipeline.
 *
 * Security: HETZNER_API_TOKEN is NOT embedded in cloud-init. The VPS does not
 * self-delete — instead, the API deletes the VPS server-side after the upload
 * job completes or fails. This prevents token exposure from the VPS metadata endpoint.
 */
export function generateUploadCloudInit(params: GenerateUploadCloudInitParams): string {
  const dockerImage = params.dockerImage || "ghcr.io/ichbinder/openmedia-uploader:latest";

  // Only 3 ENV vars — all other config fetched at boot via bootstrap API
  const envLines = [
    `JOB_ID=${params.jobId}`,
    `API_BASE_URL=${params.apiBaseUrl}`,
    `SERVICE_TOKEN=${params.serviceToken}`,
  ];

  const envContent = envLines.join("\n");
  const envBase64 = Buffer.from(envContent).toString("base64");

  const vpnConfig = params.vpnConfig ?? null;
  const vpnWriteFiles = generateVpnWriteFiles(vpnConfig, vpnConfig ? {
    apiBaseUrl: params.apiBaseUrl,
    serviceToken: params.serviceToken,
    jobId: params.jobId,
    jobEndpointPath: `/uploads/${params.jobId}`,
  } : undefined);
  const vpnRuncmd = generateVpnRuncmd(vpnConfig, "fail_job");

  return `#cloud-config

package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}${vpnWriteFiles}

runcmd:
  - |
    set -e

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/uploads/${params.jobId}" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }
${vpnRuncmd}
    if ! docker pull "${dockerImage}"; then
      fail_job "Docker pull failed: ${dockerImage}"
      exit 1
    fi

    # Run upload container — it handles everything internally:
    # S3→mkfifo→7z→PAR2→Nyuu→NZB→S3→API callback
    docker run --name openmedia-uploader \\
      --env-file /opt/openmedia-env \\
      -v /tmp:/opt/openmedia/tmp \\
      "${dockerImage}" || fail_job "Upload container failed"

    echo "openmedia-uploader exited with code $?"
    rm -f /opt/openmedia-env

    # VPS deletion is handled by the API after PATCH /uploads/:id completed/failed.
    # Do NOT embed Hetzner credentials in cloud-init.
`;
}

/**
 * Provision an ephemeral VPS for uploading MKV to Usenet.
 */
export async function provisionUploadVps(
  params: ProvisionUploadVpsParams,
): Promise<HetznerCreateServerResult> {
  const cloudInit = generateUploadCloudInit({
    jobId: params.jobId,
    apiBaseUrl: params.apiBaseUrl,
    serviceToken: params.serviceToken,
    dockerImage: params.dockerImage,
    serverName: params.serverName,
    vpnConfig: params.vpnConfig,
  });

  console.log(`[hetzner] Provisioning upload VPS: ${params.serverName}`);

  const result = await createServer({
    name: params.serverName,
    serverType: "cpx42",  // 8 vCPU x86, 16GB RAM — more power for PAR2 + Nyuu
    location: "hel1",     // Helsinki — close to Hetzner S3 and EU Usenet providers
    userData: cloudInit,
    ...(process.env.HETZNER_SSH_KEY_NAME ? { sshKeys: [process.env.HETZNER_SSH_KEY_NAME] } : {}),
    labels: {
      purpose: "openmedia-upload",
      uploadJobId: params.jobId,
      nzbHash: params.nzbFileHash.substring(0, 63),
    },
  });

  return result;
}
