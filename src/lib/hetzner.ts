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
 * Generate the traffic routing guard shell script.
 *
 * Runs every 10s on the VPS and checks all active TCP connections against
 * the routing policy (mustVpn / mustDirect). Anomalies are reported to the
 * API via POST /service/jobs/:id/events.
 *
 * Expects these environment variables at runtime:
 *   API_BASE_URL, SERVICE_TOKEN, JOB_ID, VPN_INTERFACE
 *
 * Reads /opt/routing-policy.json for the routing policy.
 */
export function generateTrafficGuardScript(): string {
  return `#!/usr/bin/env bash
set -uo pipefail

# ── Traffic Routing Guard ────────────────────────────────────────────
# Checks active TCP connections against routing policy every 10s.
# Reports anomalies to the API.

CHECK_INTERVAL=10
POLICY_FILE="/opt/routing-policy.json"
VPN_INTERFACE_FILE="/opt/vpn-interface"
SEEN_WORKLOAD=0

# VPN_INTERFACE may not be set when the guard starts (VPN setup runs after launch).
# Fall back to empty string; the loop refreshes it from $VPN_INTERFACE_FILE.
VPN_INTERFACE="\${VPN_INTERFACE:-}"

report_event() {
  local event_type="\$1" severity="\$2" details="\$3"
  curl -sf --connect-timeout 5 --max-time 10 \\
    -X POST "\${API_BASE_URL}/service/jobs/\${JOB_ID}/events" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"eventType\\":\\"\$event_type\\",\\"severity\\":\\"\$severity\\",\\"details\\":\$details}" \\
    > /dev/null 2>&1 || echo "[traffic-guard] Warning: event report failed"
}

# Wait for routing policy file
for i in 1 2 3 4 5; do
  [ -f "\$POLICY_FILE" ] && break
  echo "[traffic-guard] Waiting for routing policy..."
  sleep 2
done

if [ ! -f "\$POLICY_FILE" ]; then
  echo "[traffic-guard] No routing policy file — exiting"
  exit 0
fi

# Parse routing policy once at startup
MUST_VPN_HOSTS=$(jq -r '.mustVpn[]? | "\\(.host):\\(.port)"' "\$POLICY_FILE" 2>/dev/null)
MUST_DIRECT_CIDRS=$(jq -r '.mustDirect[]?' "\$POLICY_FILE" 2>/dev/null)

if [ -z "\$MUST_VPN_HOSTS" ] && [ -z "\$MUST_DIRECT_CIDRS" ]; then
  echo "[traffic-guard] Empty routing policy — exiting"
  exit 0
fi

echo "[traffic-guard] Started — checking every \${CHECK_INTERVAL}s"
echo "[traffic-guard] mustVpn hosts: $(echo "\$MUST_VPN_HOSTS" | tr '\\n' ' ')"
echo "[traffic-guard] mustDirect CIDRs: $(echo "\$MUST_DIRECT_CIDRS" | tr '\\n' ' ')"
echo "[traffic-guard] VPN interface: \${VPN_INTERFACE:-unknown}"

# Resolve mustVpn hostnames to IPs once (they don't change during VPS lifetime)
declare -A VPN_HOST_IPS
while IFS= read -r entry; do
  [ -z "\$entry" ] && continue
  host=\${entry%%:*}
  port=\${entry##*:}

  # Resolve hostname to IP(s)
  resolved=$(getent ahosts "\$host" 2>/dev/null | awk '{print \$1}' | sort -u)
  if [ -z "\$resolved" ]; then
    echo "[traffic-guard] Warning: cannot resolve \$host"
    continue
  fi

  for ip in \$resolved; do
    VPN_HOST_IPS["\$ip:\$port"]="\$host"
  done
done <<< "\$MUST_VPN_HOSTS"

# Convert mustDirect CIDRs to a format we can match against
# We'll use ipcalc-like matching via ip route get
declare -a DIRECT_CIDRS=()
while IFS= read -r cidr; do
  [ -z "\$cidr" ] && continue
  DIRECT_CIDRS+=("\$cidr")
done <<< "\$MUST_DIRECT_CIDRS"

# Detect the default physical interface (used as expected device for mustDirect checks)
ORIG_DEV=\$(ip route show default 2>/dev/null | grep -oP 'dev \\K\\S+' | head -1)
ORIG_DEV="\${ORIG_DEV:-eth0}"
echo "[traffic-guard] Direct interface: \$ORIG_DEV"

INITIAL_CHECK_DONE=0

get_route_dev() {
  # Returns the output device for a given destination IP
  local dst="\$1"
  ip route get "\$dst" 2>/dev/null | head -1 | grep -oP 'dev \\K\\S+'
}

ip_in_cidr() {
  # Check if an IP falls within a CIDR range using Python (available on all VPS)
  # Values passed as sys.argv to prevent shell injection
  local ip="\$1" cidr="\$2"
  python3 - "\$ip" "\$cidr" 2>/dev/null <<'PYEOF'
import ipaddress, sys
try:
  sys.exit(0 if ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network(sys.argv[2], strict=False) else 1)
except:
  sys.exit(1)
PYEOF
}

while true; do
  sleep "\$CHECK_INTERVAL"

  # Refresh VPN_INTERFACE from file written by bootstrap after VPN setup
  if [ -z "\$VPN_INTERFACE" ] && [ -f "\$VPN_INTERFACE_FILE" ]; then
    VPN_INTERFACE=\$(cat "\$VPN_INTERFACE_FILE")
  fi

  # Exit when workload containers stop (same logic as watchdog)
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q .; then
    SEEN_WORKLOAD=1
  elif [ "\$SEEN_WORKLOAD" = "1" ]; then
    echo "[traffic-guard] No running containers — exiting"
    exit 0
  fi

  ANOMALIES=""
  ANOMALY_COUNT=0

  # Parse active TCP connections from ss
  # Format: State Recv-Q Send-Q Local:Port Peer:Port Process
  while IFS= read -r line; do
    [ -z "\$line" ] && continue

    # Extract peer address (5th field) — format: ip:port or [ipv6]:port
    peer=$(echo "\$line" | awk '{print \$5}')
    [ -z "\$peer" ] && continue

    # Split peer into IP and port
    if echo "\$peer" | grep -q '^\\['; then
      # IPv6: [addr]:port
      peer_ip=$(echo "\$peer" | grep -oP '\\[\\K[^]]+')
      peer_port=$(echo "\$peer" | grep -oP '\\]:\\K[0-9]+')
    else
      # IPv4: addr:port
      peer_ip=\${peer%:*}
      peer_port=\${peer##*:}
    fi

    [ -z "\$peer_ip" ] || [ -z "\$peer_port" ] && continue

    # Skip loopback and link-local
    case "\$peer_ip" in
      127.*|::1|fe80:*) continue ;;
    esac

    # Determine actual interface for this destination
    actual_dev=$(get_route_dev "\$peer_ip")
    [ -z "\$actual_dev" ] && continue

    # Check 1: mustVpn — connection to usenet host must use VPN interface
    vpn_key="\$peer_ip:\$peer_port"
    if [ -n "\${VPN_HOST_IPS[\$vpn_key]+x}" ]; then
      vpn_hostname=\${VPN_HOST_IPS[\$vpn_key]}
      if [ "\$actual_dev" != "\${VPN_INTERFACE}" ]; then
        echo "[traffic-guard] ANOMALY: \$vpn_hostname:\$peer_port on \$actual_dev (expected \${VPN_INTERFACE})"
        ANOMALY_JSON=\$(jq -n --arg iface "\$actual_dev" --arg host "\$vpn_hostname" --argjson port "\$peer_port" --arg expected "\${VPN_INTERFACE}" --arg actual "\$actual_dev" \
          '{interface: \$iface, host: \$host, port: \$port, expected: \$expected, actual: \$actual}')
        if [ -z "\$ANOMALIES" ]; then
          ANOMALIES="\$ANOMALY_JSON"
        else
          ANOMALIES="\$ANOMALIES,\$ANOMALY_JSON"
        fi
        ANOMALY_COUNT=\$((ANOMALY_COUNT + 1))
      fi
      continue
    fi

    # Check 2: mustDirect — connection to bypass CIDR must NOT use VPN interface
    if [ "\${#DIRECT_CIDRS[@]}" -gt 0 ]; then
    for cidr in "\${DIRECT_CIDRS[@]}"; do
      if ip_in_cidr "\$peer_ip" "\$cidr"; then
        if [ "\$actual_dev" = "\${VPN_INTERFACE}" ]; then
          echo "[traffic-guard] ANOMALY: \$peer_ip:\$peer_port on \$actual_dev (expected \$ORIG_DEV, CIDR: \$cidr)"
          ANOMALY_JSON=\$(jq -n --arg iface "\$actual_dev" --arg host "\$peer_ip" --argjson port "\$peer_port" --arg expected "\$ORIG_DEV" --arg actual "\$actual_dev" --arg cidr "\$cidr" \
            '{interface: \$iface, host: \$host, port: \$port, expected: \$expected, actual: \$actual, cidr: \$cidr}')
          if [ -z "\$ANOMALIES" ]; then
            ANOMALIES="\$ANOMALY_JSON"
          else
            ANOMALIES="\$ANOMALIES,\$ANOMALY_JSON"
          fi
          ANOMALY_COUNT=\$((ANOMALY_COUNT + 1))
        fi
        break
      fi
    done
    fi
  done < <(ss -tupnH state established 2>/dev/null)

  # Report anomalies as a single batched event (throttled by signature)
  if [ "\$ANOMALY_COUNT" -gt 0 ]; then
    details="{\\"anomalyCount\\":\$ANOMALY_COUNT,\\"connections\\":[\$ANOMALIES]}"
    CURRENT_SIG=\$(echo "\$details" | md5sum | awk '{print \$1}')
    LAST_SIG=""
    [ -f /tmp/last-anomaly-sig ] && LAST_SIG=\$(cat /tmp/last-anomaly-sig)
    if [ "\$CURRENT_SIG" != "\$LAST_SIG" ]; then
      report_event "routing_anomaly" "warning" "\$details"
      echo "\$CURRENT_SIG" > /tmp/last-anomaly-sig
      echo "[traffic-guard] Reported \$ANOMALY_COUNT anomalies"
    else
      echo "[traffic-guard] \$ANOMALY_COUNT anomalies (unchanged, throttled)"
    fi
  fi

  # ── One-time routing verification after first check pass ────────────
  if [ "\$INITIAL_CHECK_DONE" = "0" ] && [ -n "\$VPN_INTERFACE" ]; then
    INITIAL_CHECK_DONE=1
    VPN_OK_COUNT=0
    VPN_FAIL_COUNT=0
    DIRECT_OK_COUNT=0
    DIRECT_FAIL_COUNT=0

    # Verify mustVpn hosts route through VPN
    for key in "\${!VPN_HOST_IPS[@]}"; do
      ip=\${key%%:*}
      dev=\$(get_route_dev "\$ip")
      if [ "\$dev" = "\$VPN_INTERFACE" ]; then
        VPN_OK_COUNT=\$((VPN_OK_COUNT + 1))
      else
        VPN_FAIL_COUNT=\$((VPN_FAIL_COUNT + 1))
      fi
    done

    # Verify mustDirect CIDRs route through physical interface
    for cidr in "\${DIRECT_CIDRS[@]}"; do
      # Use first IP in CIDR as probe
      probe_ip=\$(python3 -c "import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1],strict=False).hosts()))" "\$cidr" 2>/dev/null)
      [ -z "\$probe_ip" ] && continue
      dev=\$(get_route_dev "\$probe_ip")
      if [ "\$dev" != "\$VPN_INTERFACE" ]; then
        DIRECT_OK_COUNT=\$((DIRECT_OK_COUNT + 1))
      else
        DIRECT_FAIL_COUNT=\$((DIRECT_FAIL_COUNT + 1))
      fi
    done

    VERDICT="pass"
    [ "\$VPN_FAIL_COUNT" -gt 0 ] || [ "\$DIRECT_FAIL_COUNT" -gt 0 ] && VERDICT="fail"
    SEVERITY="info"
    [ "\$VERDICT" = "fail" ] && SEVERITY="warning"

    report_event "routing_verified" "\$SEVERITY" "{\\"verdict\\":\\"\$VERDICT\\",\\"vpnInterface\\":\\"\$VPN_INTERFACE\\",\\"directInterface\\":\\"\$ORIG_DEV\\",\\"mustVpn\\":{\\"ok\\":\$VPN_OK_COUNT,\\"fail\\":\$VPN_FAIL_COUNT},\\"mustDirect\\":{\\"ok\\":\$DIRECT_OK_COUNT,\\"fail\\":\$DIRECT_FAIL_COUNT}}"
    echo "[traffic-guard] Routing verified: mustVpn=\${VPN_OK_COUNT}ok/\${VPN_FAIL_COUNT}fail, mustDirect=\${DIRECT_OK_COUNT}ok/\${DIRECT_FAIL_COUNT}fail (\$VERDICT)"
  fi
done`;
}

/**
 * Generate the bootstrap shell script that runs on the VPS at boot.
 * It fetches all configuration (VPN, S3, Usenet) dynamically from the
 * Bootstrap API, then configures VPN (WireGuard or OpenVPN), sets up
 * iptables kill-switch + bypass routes, and starts the VPN watchdog.
 *
 * This replaces the old static approach where VPN config was baked into
 * cloud-init write_files at provisioning time.
 *
 * @param jobType  "download" or "upload" — determines the fail_job endpoint path
 */
export function generateBootstrapScript(params: {
  jobId: string;
  apiBaseUrl: string;
  serviceToken: string;
  jobType: "download" | "upload";
}): string {
  const failEndpoint = params.jobType === "download"
    ? `/downloads/jobs/${params.jobId}/status`
    : `/uploads/${params.jobId}`;

  return `#!/usr/bin/env bash
set -euo pipefail

# ── Dynamic VPN Bootstrap ───────────────────────────────────────────���─
# Fetches VPN config from the Bootstrap API and configures the tunnel
# dynamically. No static VPN config in cloud-init.

# Source env from cloud-init write_files (fallback to params for compat)
if [ -f /opt/openmedia-env ]; then
  set +u; set -a; . /opt/openmedia-env; set +a; set -u
fi
API_BASE_URL="\${API_BASE_URL:-${params.apiBaseUrl}}"
SERVICE_TOKEN="\${SERVICE_TOKEN:-${params.serviceToken}}"
JOB_ID="\${JOB_ID:-${params.jobId}}"
FAIL_ENDPOINT="${failEndpoint}"

fail_job() {
  local msg="\$1"
  echo "[bootstrap] FATAL: \$msg"
  curl -sf -X PATCH "\${API_BASE_URL}\${FAIL_ENDPOINT}" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"status\\":\\"failed\\",\\"error\\":\\"\$msg\\"}" || true
}

report_event() {
  local event_type="\$1" severity="\$2" details="\$3"
  curl -sf --connect-timeout 5 --max-time 10 \\
    -X POST "\${API_BASE_URL}/service/jobs/\${JOB_ID}/events" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"eventType\\":\\"\$event_type\\",\\"severity\\":\\"\$severity\\",\\"details\\":\$details}" \\
    > /dev/null 2>&1 || echo "[bootstrap] Warning: event report failed"
}

echo "[bootstrap] Fetching config from API..."
BOOTSTRAP_JSON=$(curl -sf --connect-timeout 10 --max-time 30 \\
  "\${API_BASE_URL}/service/jobs/\${JOB_ID}/bootstrap" \\
  -H "Authorization: Bearer \${SERVICE_TOKEN}") || {
  fail_job "Bootstrap API call failed"
  exit 1
}

# ── Save routing policy for Traffic Guard ─────────────────────────────
ROUTING_POLICY=$(echo "\$BOOTSTRAP_JSON" | jq '.routingPolicy // empty')
if [ -n "\$ROUTING_POLICY" ] && [ "\$ROUTING_POLICY" != "null" ]; then
  echo "\$ROUTING_POLICY" > /opt/routing-policy.json
  chmod 600 /opt/routing-policy.json
  echo "[bootstrap] Routing policy saved to /opt/routing-policy.json"

  # ── Traffic Routing Guard ─────────────────────────────────────────
  cat > /opt/traffic-guard.sh << 'TRAFFIC_GUARD_EOF'
${generateTrafficGuardScript()}
TRAFFIC_GUARD_EOF

  chmod 700 /opt/traffic-guard.sh
  export JOB_ID API_BASE_URL SERVICE_TOKEN
  nohup /opt/traffic-guard.sh > /var/log/traffic-guard.log 2>&1 &
  echo "[bootstrap] Traffic Guard started"
else
  echo "[bootstrap] No routing policy — Traffic Guard skipped"
fi

# Check if VPN config is present in the response
VPN_PROTOCOL=$(echo "\$BOOTSTRAP_JSON" | jq -r '.vpnConfig.protocol // empty')

if [ -z "\$VPN_PROTOCOL" ]; then
  echo "[bootstrap] No VPN config — skipping VPN setup"
  exit 0
fi

echo "[bootstrap] VPN protocol: \$VPN_PROTOCOL"

# Extract VPN config fields
VPN_CONFIG_BLOB=$(echo "\$BOOTSTRAP_JSON" | jq -r '.vpnConfig.configBlob')
VPN_USERNAME=$(echo "\$BOOTSTRAP_JSON" | jq -r '.vpnConfig.username // empty')
VPN_PASSWORD=$(echo "\$BOOTSTRAP_JSON" | jq -r '.vpnConfig.password // empty')

# Extract excludedCIDRs as newline-separated list
EXCLUDED_CIDRS=$(echo "\$BOOTSTRAP_JSON" | jq -r '.vpnConfig.excludedCIDRs[]? // empty')

# ── Install VPN software ──────────────────────────────────────────────
echo "[vpn] Updating package lists..."
apt-get update -qq > /dev/null 2>&1

if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
  echo "[vpn] Installing openvpn..."
  if ! timeout 60 apt-get install -y openvpn jq > /dev/null 2>&1; then
    fail_job "VPN setup failed: apt install openvpn timed out or failed"
    exit 1
  fi
else
  echo "[vpn] Installing wireguard-tools..."
  if ! timeout 60 apt-get install -y wireguard-tools jq > /dev/null 2>&1; then
    fail_job "VPN setup failed: apt install wireguard-tools timed out or failed"
    exit 1
  fi
fi

# ── Write VPN config files ────────────────────────────────────────────
if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
  # OpenVPN: write config + optional auth file
  OVPN_CONF="\$VPN_CONFIG_BLOB"

  if [ -n "\$VPN_USERNAME" ] && [ -n "\$VPN_PASSWORD" ]; then
    # Inject or replace auth-user-pass directive
    if printf '%s\\n' "\$OVPN_CONF" | grep -q '^[[:space:]]*auth-user-pass'; then
      OVPN_CONF=$(printf '%s\\n' "\$OVPN_CONF" | sed 's|^[[:space:]]*auth-user-pass.*|auth-user-pass /etc/openvpn/auth.txt|')
    else
      OVPN_CONF="\${OVPN_CONF}
auth-user-pass /etc/openvpn/auth.txt"
    fi

    # Write credentials file
    printf '%s\\n%s\\n' "\$VPN_USERNAME" "\$VPN_PASSWORD" > /etc/openvpn/auth.txt
    chmod 600 /etc/openvpn/auth.txt
  else
    # Remove any auth-user-pass directive to prevent interactive prompt
    OVPN_CONF=$(printf '%s\\n' "\$OVPN_CONF" | sed '/^[[:space:]]*auth-user-pass/d')
  fi

  mkdir -p /etc/openvpn
  printf '%s\\n' "\$OVPN_CONF" > /etc/openvpn/client.conf
  chmod 600 /etc/openvpn/client.conf

  VPN_INTERFACE="tun0"
else
  # WireGuard: write config
  mkdir -p /etc/wireguard
  printf '%s\\n' "\$VPN_CONFIG_BLOB" > /etc/wireguard/wg0.conf
  chmod 600 /etc/wireguard/wg0.conf

  VPN_INTERFACE="wg0"
fi

# Write VPN_INTERFACE to file so Traffic Guard can pick it up (it may have
# started before VPN setup completed and cannot inherit this variable yet)
echo "\$VPN_INTERFACE" > /opt/vpn-interface
chmod 600 /opt/vpn-interface

# ── Capture default gateways before VPN overwrites routing ────────────
ORIG_GW=$(ip route show default | awk '{print \$3}')
ORIG_DEV=$(ip route show default | awk '{print \$5}')
ORIG_GW6=$(ip -6 route show default 2>/dev/null | awk '{print \$3}')
ORIG_DEV6=$(ip -6 route show default 2>/dev/null | awk '{print \$5}')
echo "[vpn] Default gateway: \$ORIG_GW via \$ORIG_DEV"

# ── iptables kill-switch ──────────────────────────────────────────────
# Parse VPN endpoint for ACCEPT rule
if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
  ENDPOINT_HOST=$(printf '%s\\n' "\$VPN_CONFIG_BLOB" | grep -oP '^\\s*remote\\s+\\K\\S+' | head -1)
else
  ENDPOINT_RAW=$(printf '%s\\n' "\$VPN_CONFIG_BLOB" | grep -oP '^\\s*Endpoint\\s*=\\s*\\K.+' | head -1 | xargs)
  # Handle bracketed IPv6: [addr]:port
  if printf '%s\\n' "\$ENDPOINT_RAW" | grep -qP '^\\['; then
    ENDPOINT_HOST=$(printf '%s\\n' "\$ENDPOINT_RAW" | grep -oP '\\[\\K[^]]+')
  else
    ENDPOINT_HOST=$(printf '%s\\n' "\$ENDPOINT_RAW" | sed 's/:[0-9]*\$//')
  fi
fi

# Determine if endpoint is IPv6
ENDPOINT_IS_IPV6=0
echo "\$ENDPOINT_HOST" | grep -q ':' && ENDPOINT_IS_IPV6=1

# IPv4 kill-switch
iptables -A OUTPUT -o lo -j ACCEPT
if [ -n "\$ENDPOINT_HOST" ] && [ "\$ENDPOINT_IS_IPV6" = "0" ]; then
  iptables -A OUTPUT -d "\$ENDPOINT_HOST" -j ACCEPT
fi
iptables -A OUTPUT -o "\$VPN_INTERFACE" -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d 169.254.169.254/32 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT

# Allow fail_job callbacks to the API even when VPN is down
API_CALLBACK_HOST=$(echo "\$API_BASE_URL" | sed -E 's|https?://||' | sed 's|:[0-9]*$||' | sed 's|/.*||')
if echo "\$API_CALLBACK_HOST" | grep -q ':'; then
  ip6tables -I OUTPUT 1 -d "\$API_CALLBACK_HOST" -j ACCEPT
else
  iptables -I OUTPUT 1 -d "\$API_CALLBACK_HOST" -j ACCEPT
fi

iptables -A OUTPUT -j DROP

# IPv6 kill-switch
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -o "\$VPN_INTERFACE" -j ACCEPT
ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
if [ -n "\$ENDPOINT_HOST" ] && [ "\$ENDPOINT_IS_IPV6" = "1" ]; then
  ip6tables -A OUTPUT -d "\$ENDPOINT_HOST" -j ACCEPT
fi
ip6tables -A OUTPUT -j DROP

# Bypass ACCEPT rules for excludedCIDRs (inserted at top of OUTPUT chain)
echo "\$EXCLUDED_CIDRS" | while IFS= read -r cidr; do
  [ -z "\$cidr" ] && continue
  if echo "\$cidr" | grep -q ':'; then
    ip6tables -I OUTPUT 1 -d "\$cidr" -j ACCEPT
  else
    iptables -I OUTPUT 1 -d "\$cidr" -j ACCEPT
  fi
done

echo "[vpn] Kill-switch active (iptables + ip6tables)"

# ── Start VPN tunnel ──────────────────────────────────────────────────
if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
  openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log

  echo "[vpn] Waiting for tun0 interface..."
  TUN_UP=0
  for i in $(seq 1 30); do
    if ip link show tun0 > /dev/null 2>&1; then
      TUN_UP=1
      break
    fi
    sleep 1
  done
  if [ "\$TUN_UP" = "0" ]; then
    echo "[vpn] OpenVPN log:"
    cat /var/log/openvpn.log 2>/dev/null || true
    fail_job "VPN setup failed: tun0 not up after 30s"
    exit 1
  fi
  echo "[vpn] OpenVPN tunnel up (tun0)"
else
  if ! timeout 30 wg-quick up wg0; then
    fail_job "VPN setup failed: wg-quick up wg0 failed"
    exit 1
  fi
  echo "[vpn] WireGuard tunnel up"
fi

# ── Bypass routes for excludedCIDRs ───────────────────────────────────
echo "\$EXCLUDED_CIDRS" | while IFS= read -r cidr; do
  [ -z "\$cidr" ] && continue
  if echo "\$cidr" | grep -q ':'; then
    if ! ip -6 route add "\$cidr" via "\$ORIG_GW6" dev "\${ORIG_DEV6:-\$ORIG_DEV}"; then
      echo "[vpn] Warning: bypass route failed for \$cidr"
    fi
  else
    if ! ip route add "\$cidr" via "\$ORIG_GW" dev "\$ORIG_DEV"; then
      echo "[vpn] Warning: bypass route failed for \$cidr"
    fi
  fi
done

# DNS leak fix
echo 'nameserver 1.1.1.1' > /etc/resolv.conf

# ── Verify VPN connectivity ──────────────────────────────────────────
sleep 3
VPN_OK=0
for i in 1 2 3; do
  if timeout 10 curl -sf --interface "\$VPN_INTERFACE" http://1.1.1.1/cdn-cgi/trace > /dev/null 2>&1; then
    VPN_OK=1
    break
  fi
  echo "[vpn] Connectivity check attempt \$i failed, retrying..."
  sleep 3
done
if [ "\$VPN_OK" = "0" ]; then
  fail_job "VPN setup failed: connectivity check through \$VPN_INTERFACE failed after 3 attempts"
  exit 1
fi

echo "[vpn] Connectivity verified through \$VPN_INTERFACE"

# ── Report bootstrap_complete event ──────────────────────────────────
VPN_PUBLIC_IP=$(curl -sf --interface "\$VPN_INTERFACE" --connect-timeout 5 "https://api.ipify.org" 2>/dev/null || echo "unknown")
report_event "bootstrap_complete" "info" "{\\"protocol\\":\\"\$VPN_PROTOCOL\\",\\"interface\\":\\"\$VPN_INTERFACE\\",\\"vpnPublicIp\\":\\"\$VPN_PUBLIC_IP\\"}"
echo "[bootstrap] Reported bootstrap_complete (VPN IP: \$VPN_PUBLIC_IP)"

# ── VPN Watchdog ──────────────────────────────────────────────────────
# Write watchdog script dynamically (identical logic to the old static version)
cat > /opt/vpn-watchdog.sh << 'WATCHDOG_EOF'
#!/usr/bin/env bash
set -euo pipefail

# VPN Watchdog — reconnect with backoff (R018), fail after 3 attempts (R019)

BACKOFF_DELAYS=(5 15 30)
MAX_RETRIES=3
CHECK_INTERVAL=10

watchdog_fail_job() {
  local msg="\$1"
  echo "[vpn-watchdog] FATAL: \$msg"
  curl -sf -X PATCH "\${API_BASE_URL}\${FAIL_ENDPOINT}" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"status\\":\\"failed\\",\\"error\\":\\"\$msg\\"}" || true
}

watchdog_report_event() {
  local event_type="\$1" severity="\$2" details="\$3"
  curl -sf --connect-timeout 5 --max-time 10 \\
    -X POST "\${API_BASE_URL}/service/jobs/\${JOB_ID}/events" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"eventType\\":\\"\$event_type\\",\\"severity\\":\\"\$severity\\",\\"details\\":\$details}" \\
    > /dev/null 2>&1 || echo "[vpn-watchdog] Warning: event report failed"
}

reconnect_vpn() {
  if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
    killall -9 openvpn 2>/dev/null || true
    sleep 1
    openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log
    for j in $(seq 1 30); do
      ip link show tun0 > /dev/null 2>&1 && break
      sleep 1
    done
  else
    wg-quick down wg0 2>/dev/null || true
    wg-quick up wg0
  fi
}

health_check() {
  # Only check VPN connectivity — API reachability is a separate concern (K111)
  curl -sf --interface "\$VPN_INTERFACE" --connect-timeout 5 --max-time 10 "https://api.ipify.org" > /dev/null 2>&1
}

echo "[vpn-watchdog] Started — monitoring \$VPN_INTERFACE every \${CHECK_INTERVAL}s"

SEEN_WORKLOAD=0

while true; do
  sleep "\$CHECK_INTERVAL"

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q .; then
    SEEN_WORKLOAD=1
  elif [ "\$SEEN_WORKLOAD" = "1" ]; then
    echo "[vpn-watchdog] No running containers — exiting"
    exit 0
  fi

  if health_check; then
    continue
  fi

  echo "[vpn-watchdog] Health check failed — starting reconnect sequence"
  watchdog_report_event "vpn_down" "warning" "{\\"protocol\\":\\"\$VPN_PROTOCOL\\",\\"interface\\":\\"\$VPN_INTERFACE\\"}"

  RECONNECTED=0
  for attempt in $(seq 0 $((MAX_RETRIES - 1))); do
    delay=\${BACKOFF_DELAYS[\$attempt]}
    echo "[vpn-watchdog] Reconnect attempt $((attempt + 1))/\$MAX_RETRIES (backoff: \${delay}s)"
    sleep "\$delay"

    reconnect_vpn

    sleep 2
    if health_check; then
      echo "[vpn-watchdog] Reconnected successfully on attempt $((attempt + 1))"
      watchdog_report_event "vpn_reconnect" "info" "{\\"protocol\\":\\"\$VPN_PROTOCOL\\",\\"interface\\":\\"\$VPN_INTERFACE\\",\\"attempt\\":$((attempt + 1))}"
      RECONNECTED=1
      break
    fi
  done

  if [ "\$RECONNECTED" = "0" ]; then
    watchdog_report_event "vpn_reconnect_failed" "error" "{\\"protocol\\":\\"\$VPN_PROTOCOL\\",\\"interface\\":\\"\$VPN_INTERFACE\\",\\"attempts\\":\$MAX_RETRIES}"
    watchdog_fail_job "VPN reconnect exhausted after \$MAX_RETRIES attempts"
    exit 1
  fi
done
WATCHDOG_EOF

chmod 700 /opt/vpn-watchdog.sh
export VPN_PROTOCOL VPN_INTERFACE API_BASE_URL SERVICE_TOKEN FAIL_ENDPOINT JOB_ID
nohup /opt/vpn-watchdog.sh > /var/log/vpn-watchdog.log 2>&1 &

echo "[bootstrap] VPN setup complete"
`;
}

export function generateCloudInit(params: {
  jobId: string;
  apiBaseUrl: string;
  serviceToken: string;
  dockerImage: string;
  serverName: string;
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

  return `#cloud-config
package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}

runcmd:
  - |
    set -e

    # Disable IPv6 — all traffic must go through the WireGuard IPv4 tunnel
    sysctl -w net.ipv6.conf.all.disable_ipv6=1
    sysctl -w net.ipv6.conf.default.disable_ipv6=1

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

    # Install jq with retry (network may not be ready immediately on ARM VPS)
    for i in 1 2 3; do
      apt-get update -qq > /dev/null 2>&1 && apt-get install -y jq > /dev/null 2>&1 && break
      echo "[cloud-init] apt-get attempt $i failed, retrying in 5s..."
      sleep 5
    done
    if ! command -v jq > /dev/null 2>&1; then
      fail_job "jq installation failed after 3 attempts"
      exit 1
    fi

    # Fetch bootstrap script from API (avoids 32KB user_data limit)
    echo "[cloud-init] Fetching bootstrap script..."
    for i in 1 2 3; do
      if curl -sf --connect-timeout 10 --max-time 30 \\
        "${params.apiBaseUrl}/service/jobs/${params.jobId}/bootstrap-script" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -o /opt/bootstrap.sh; then
        break
      fi
      echo "[cloud-init] Bootstrap script fetch attempt $i failed, retrying in 5s..."
      sleep 5
    done
    if [ ! -s /opt/bootstrap.sh ]; then
      fail_job "Bootstrap script fetch failed after 3 attempts"
      exit 1
    fi
    chmod 700 /opt/bootstrap.sh

    # Run dynamic VPN bootstrap (fetches config from API, sets up VPN + kill-switch)
    /opt/bootstrap.sh || exit 1

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
    rm -f /opt/openmedia-env

    # Self-cleanup: ask the API to delete this VPS with retry (K112)
    echo "Requesting self-cleanup via API..."
    CLEANUP_OK=0
    for attempt in 1 2 3; do
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 -X POST "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/cleanup" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json")
      echo "Self-cleanup attempt \$attempt returned HTTP \$HTTP_CODE"
      if [ "\$HTTP_CODE" -ge 200 ] && [ "\$HTTP_CODE" -lt 300 ] || [ "\$HTTP_CODE" = "422" ]; then
        echo "Self-cleanup request succeeded on attempt \$attempt (HTTP \$HTTP_CODE)"
        CLEANUP_OK=1
        break
      fi
      echo "Self-cleanup attempt \$attempt failed (HTTP \$HTTP_CODE), retrying in \$((attempt * 5))s..."
      sleep \$((attempt * 5))
    done

    if [ "\$CLEANUP_OK" = "0" ]; then
      echo "All self-cleanup attempts failed (reconciler will handle)"
    fi
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
}

export interface ProvisionUploadVpsParams {
  jobId: string;
  nzbFileHash: string;
  apiBaseUrl: string;
  serviceToken: string;
  dockerImage?: string;
  serverName: string;
}

/**
 * Generate cloud-init for an ephemeral upload VPS.
 * Similar to generateCloudInit but for the upload pipeline.
 *
 * VPN config is fetched dynamically at boot via the bootstrap script —
 * no static VPN config in cloud-init.
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

  return `#cloud-config

package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}

runcmd:
  - |
    set -e

    # Disable IPv6 — all traffic must go through the WireGuard IPv4 tunnel
    sysctl -w net.ipv6.conf.all.disable_ipv6=1
    sysctl -w net.ipv6.conf.default.disable_ipv6=1

    # Source the env file for use in this script
    set -a
    . /opt/openmedia-env
    set +a

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/uploads/${params.jobId}" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }

    # Install jq with retry (network may not be ready immediately on ARM VPS)
    for i in 1 2 3; do
      apt-get update -qq > /dev/null 2>&1 && apt-get install -y jq > /dev/null 2>&1 && break
      echo "[cloud-init] apt-get attempt $i failed, retrying in 5s..."
      sleep 5
    done
    if ! command -v jq > /dev/null 2>&1; then
      fail_job "jq installation failed after 3 attempts"
      exit 1
    fi

    # Fetch bootstrap script from API (avoids 32KB user_data limit)
    echo "[cloud-init] Fetching bootstrap script..."
    for i in 1 2 3; do
      if curl -sf --connect-timeout 10 --max-time 30 \\
        "${params.apiBaseUrl}/service/jobs/${params.jobId}/bootstrap-script" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -o /opt/bootstrap.sh; then
        break
      fi
      echo "[cloud-init] Bootstrap script fetch attempt $i failed, retrying in 5s..."
      sleep 5
    done
    if [ ! -s /opt/bootstrap.sh ]; then
      fail_job "Bootstrap script fetch failed after 3 attempts"
      exit 1
    fi
    chmod 700 /opt/bootstrap.sh

    # Run dynamic VPN bootstrap (fetches config from API, sets up VPN + kill-switch)
    /opt/bootstrap.sh || exit 1

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
  });

  console.log(`[hetzner] Provisioning upload VPS: ${params.serverName}`);

  const rawNetworkId = process.env.HETZNER_NETWORK_ID;
  const networkId = rawNetworkId && /^\d+$/.test(rawNetworkId) ? parseInt(rawNetworkId, 10) : undefined;
  if (rawNetworkId && !networkId) {
    console.warn(`[hetzner] HETZNER_NETWORK_ID is not a valid number: "${rawNetworkId}" — upload VPS will not be attached to private network`);
  }

  const result = await createServer({
    name: params.serverName,
    serverType: "cpx42",  // 8 vCPU x86, 16GB RAM — more power for PAR2 + Nyuu
    location: "hel1",     // Helsinki — close to Hetzner S3 and EU Usenet providers
    userData: cloudInit,
    ...(process.env.HETZNER_SSH_KEY_NAME ? { sshKeys: [process.env.HETZNER_SSH_KEY_NAME] } : {}),
    networks: networkId ? [networkId] : undefined,
    labels: {
      purpose: "openmedia-upload",
      uploadJobId: params.jobId,
      nzbHash: params.nzbFileHash.substring(0, 63),
    },
  });

  return result;
}
