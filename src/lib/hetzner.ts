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

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/uploads/${params.jobId}" \\
        -H "Authorization: Bearer ${params.serviceToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }

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
    ...(process.env.HETZNER_SSH_KEY ? { sshKeys: [process.env.HETZNER_SSH_KEY] } : {}),
    labels: {
      purpose: "openmedia-upload",
      uploadJobId: params.jobId,
      nzbHash: params.nzbFileHash.substring(0, 63),
    },
  });

  return result;
}
