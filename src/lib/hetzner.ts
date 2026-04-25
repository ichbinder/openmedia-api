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

# ── Dynamic VPN Bootstrap ─────────────────────────────────────────────
# Fetches VPN config from the Bootstrap API and configures the tunnel
# dynamically. No static VPN config in cloud-init.

API_BASE_URL="${params.apiBaseUrl}"
SERVICE_TOKEN="${params.serviceToken}"
JOB_ID="${params.jobId}"
FAIL_ENDPOINT="${failEndpoint}"

fail_job() {
  local msg="\$1"
  echo "[bootstrap] FATAL: \$msg"
  curl -sf -X PATCH "\${API_BASE_URL}\${FAIL_ENDPOINT}" \\
    -H "Authorization: Bearer \${SERVICE_TOKEN}" \\
    -H "Content-Type: application/json" \\
    -d "{\\"status\\":\\"failed\\",\\"error\\":\\"\$msg\\"}" || true
}

echo "[bootstrap] Fetching config from API..."
BOOTSTRAP_JSON=$(curl -sf --connect-timeout 10 --max-time 30 \\
  "\${API_BASE_URL}/service/jobs/\${JOB_ID}/bootstrap" \\
  -H "Authorization: Bearer \${SERVICE_TOKEN}") || {
  fail_job "Bootstrap API call failed"
  exit 1
}

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
  echo "[vpn] Installing openvpn + jq..."
  if ! timeout 60 apt-get install -y openvpn > /dev/null 2>&1; then
    fail_job "VPN setup failed: apt install openvpn timed out or failed"
    exit 1
  fi
else
  echo "[vpn] Installing wireguard-tools + jq..."
  if ! timeout 60 apt-get install -y wireguard-tools > /dev/null 2>&1; then
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
    if echo "\$OVPN_CONF" | grep -q '^[[:space:]]*auth-user-pass'; then
      OVPN_CONF=$(echo "\$OVPN_CONF" | sed 's|^[[:space:]]*auth-user-pass.*|auth-user-pass /etc/openvpn/auth.txt|')
    else
      OVPN_CONF="\${OVPN_CONF}
auth-user-pass /etc/openvpn/auth.txt"
    fi

    # Write credentials file
    printf '%s\\n%s\\n' "\$VPN_USERNAME" "\$VPN_PASSWORD" > /etc/openvpn/auth.txt
    chmod 600 /etc/openvpn/auth.txt
  else
    # Remove any auth-user-pass directive to prevent interactive prompt
    OVPN_CONF=$(echo "\$OVPN_CONF" | sed '/^[[:space:]]*auth-user-pass/d')
  fi

  mkdir -p /etc/openvpn
  echo "\$OVPN_CONF" > /etc/openvpn/client.conf
  chmod 600 /etc/openvpn/client.conf

  VPN_INTERFACE="tun0"
else
  # WireGuard: write config
  mkdir -p /etc/wireguard
  echo "\$VPN_CONFIG_BLOB" > /etc/wireguard/wg0.conf
  chmod 600 /etc/wireguard/wg0.conf

  VPN_INTERFACE="wg0"
fi

# ── Capture default gateways before VPN overwrites routing ────────────
ORIG_GW=$(ip route show default | awk '{print \$3}')
ORIG_DEV=$(ip route show default | awk '{print \$5}')
ORIG_GW6=$(ip -6 route show default 2>/dev/null | awk '{print \$3}')
ORIG_DEV6=$(ip -6 route show default 2>/dev/null | awk '{print \$5}')
echo "[vpn] Default gateway: \$ORIG_GW via \$ORIG_DEV"

# ── iptables kill-switch ──────────────────────────────────────────────
# Parse VPN endpoint for ACCEPT rule
if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
  ENDPOINT_HOST=$(echo "\$VPN_CONFIG_BLOB" | grep -oP '^\\s*remote\\s+\\K\\S+' | head -1)
else
  ENDPOINT_RAW=$(echo "\$VPN_CONFIG_BLOB" | grep -oP '^\\s*Endpoint\\s*=\\s*\\K.+' | head -1 | xargs)
  # Handle bracketed IPv6: [addr]:port
  if echo "\$ENDPOINT_RAW" | grep -qP '^\\['; then
    ENDPOINT_HOST=$(echo "\$ENDPOINT_RAW" | grep -oP '\\[\\K[^]]+')
  else
    ENDPOINT_HOST=$(echo "\$ENDPOINT_RAW" | sed 's/:[0-9]*\$//')
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
iptables -A OUTPUT -j DROP

# IPv6 kill-switch
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -o "\$VPN_INTERFACE" -j ACCEPT
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
    if [ "\$VPN_PROTOCOL" = "openvpn" ]; then
      if ! ip route add "\$cidr" via "\$ORIG_GW" dev "\$ORIG_DEV"; then
        echo "[vpn] Warning: bypass route failed for \$cidr"
      fi
    else
      if ! ip route add "\$cidr" via "\$ORIG_GW" dev "\$ORIG_DEV"; then
        echo "[vpn] Warning: bypass route failed for \$cidr"
      fi
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
  curl -sf --interface "\$VPN_INTERFACE" --connect-timeout 5 "https://api.ipify.org" > /dev/null 2>&1 \\
    && curl -sf --connect-timeout 5 "\${API_BASE_URL}/health" > /dev/null 2>&1
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

  RECONNECTED=0
  for attempt in $(seq 0 $((MAX_RETRIES - 1))); do
    delay=\${BACKOFF_DELAYS[\$attempt]}
    echo "[vpn-watchdog] Reconnect attempt $((attempt + 1))/\$MAX_RETRIES (backoff: \${delay}s)"
    sleep "\$delay"

    reconnect_vpn

    sleep 2
    if health_check; then
      echo "[vpn-watchdog] Reconnected successfully on attempt $((attempt + 1))"
      RECONNECTED=1
      break
    fi
  done

  if [ "\$RECONNECTED" = "0" ]; then
    watchdog_fail_job "VPN reconnect exhausted after \$MAX_RETRIES attempts"
    exit 1
  fi
done
WATCHDOG_EOF

chmod 700 /opt/vpn-watchdog.sh
export VPN_PROTOCOL VPN_INTERFACE API_BASE_URL SERVICE_TOKEN FAIL_ENDPOINT
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

  // Bootstrap script fetches VPN config dynamically from the API
  const bootstrapScript = generateBootstrapScript({
    jobId: params.jobId,
    apiBaseUrl: params.apiBaseUrl,
    serviceToken: params.serviceToken,
    jobType: "download",
  });
  const bootstrapBase64 = Buffer.from(bootstrapScript).toString("base64");

  return `#cloud-config
package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}
  - path: /opt/bootstrap.sh
    permissions: "0700"
    encoding: b64
    content: ${bootstrapBase64}

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

    # Install jq for JSON parsing in bootstrap script
    apt-get update -qq > /dev/null 2>&1
    if ! timeout 60 apt-get install -y jq > /dev/null 2>&1; then
      fail_job "Bootstrap setup failed: apt install jq timed out or failed"
      exit 1
    fi

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

    # Self-cleanup: ask the API to delete this VPS using the per-VPS service token
    echo "Requesting self-cleanup via API..."
    curl -sf --connect-timeout 5 --max-time 15 -X POST "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/cleanup" \\
      -H "Authorization: Bearer ${params.serviceToken}" \\
      -H "Content-Type: application/json" || echo "Self-cleanup request failed (reconciler will handle)"
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

  // Bootstrap script fetches VPN config dynamically from the API
  const bootstrapScript = generateBootstrapScript({
    jobId: params.jobId,
    apiBaseUrl: params.apiBaseUrl,
    serviceToken: params.serviceToken,
    jobType: "upload",
  });
  const bootstrapBase64 = Buffer.from(bootstrapScript).toString("base64");

  return `#cloud-config

package_update: false

write_files:
  - path: /opt/openmedia-env
    permissions: "0600"
    encoding: b64
    content: ${envBase64}
  - path: /opt/bootstrap.sh
    permissions: "0700"
    encoding: b64
    content: ${bootstrapBase64}

runcmd:
  - |
    set -e

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/uploads/${params.jobId}" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }

    # Install jq for JSON parsing in bootstrap script
    apt-get update -qq > /dev/null 2>&1
    if ! timeout 60 apt-get install -y jq > /dev/null 2>&1; then
      fail_job "Bootstrap setup failed: apt install jq timed out or failed"
      exit 1
    fi

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
