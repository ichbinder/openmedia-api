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
  const servers = await listServers("purpose=openmedia-download");

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

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
 * The script:
 * 1. Pulls and runs SABnzbd in Docker
 * 2. Configures SABnzbd with Usenet server credentials
 * 3. Sets up post-processing: hash files → upload to S3 → callback to API
 * 4. Triggers self-destruction after completion
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
  nzbHash: string;
  nzbUrl: string;
  apiBaseUrl: string;
  apiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  /** Preferred: array of Usenet servers with individual priorities */
  usenetServers?: UsenetServer[];
  /** Legacy: single primary server */
  usenetHost?: string;
  usenetPort?: number;
  usenetUser?: string;
  usenetPassword?: string;
  usenetSsl?: boolean;
  usenetConnections?: number;
  /** Legacy: single backup server */
  usenetBackupHost?: string;
  usenetBackupPort?: number;
  usenetBackupUser?: string;
  usenetBackupPassword?: string;
  usenetBackupSsl?: boolean;
  usenetBackupConnections?: number;
  dockerImage: string;
  serverName: string;
}): string {
  // Build Usenet server list — prefer usenetServers array, fall back to legacy ENV vars
  let servers: UsenetServer[] = [];

  if (params.usenetServers && params.usenetServers.length > 0) {
    servers = params.usenetServers;
  } else if (params.usenetHost && params.usenetUser) {
    // Legacy: build from individual params
    servers.push({
      host: params.usenetHost,
      port: params.usenetPort ?? 563,
      username: params.usenetUser,
      password: params.usenetPassword ?? "",
      ssl: params.usenetSsl ?? true,
      connections: params.usenetConnections ?? 10,
      optional: 0,
      priority: 0,
    });

    if (params.usenetBackupHost && params.usenetBackupUser) {
      servers.push({
        host: params.usenetBackupHost,
        port: params.usenetBackupPort ?? 563,
        username: params.usenetBackupUser,
        password: params.usenetBackupPassword ?? "",
        ssl: params.usenetBackupSsl !== false,
        connections: params.usenetBackupConnections ?? 10,
        optional: 1,
        priority: 1,
      });
    }
  }

  // Build env file content
  const envLines = [
    `JOB_ID=${params.jobId}`,
    `JOB_HASH=${params.nzbHash}`,
    `NZB_URL=${params.nzbUrl}`,
    `API_BASE_URL=${params.apiBaseUrl}`,
    `SERVICE_TOKEN=${params.apiToken}`,
    `S3_ACCESS_KEY=${params.s3AccessKey}`,
    `S3_SECRET_KEY=${params.s3SecretKey}`,
    `S3_ENDPOINT=${params.s3Endpoint}`,
    `S3_BUCKET=${params.s3Bucket}`,
    `S3_REGION=${params.s3Region}`,
    `PUID=0`,
    `PGID=0`,
    `DL_HOSTNAME=${params.serverName}`,
  ];

  // Pass servers as JSON array — the downloader parses this with jq
  if (servers.length > 0) {
    const serversJson = JSON.stringify(servers.map((s, i) => ({
      host: s.host,
      port: s.port ?? 563,
      username: s.username,
      password: s.password,
      ssl: s.ssl !== false,
      connections: s.connections ?? 10,
      optional: s.optional ?? (i > 0 ? 1 : 0),
      priority: s.priority ?? i,
    })));
    envLines.push(`USENET_SERVERS=${serversJson}`);
  }

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

    fail_job() {
      curl -sf -X PATCH "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/status" \\
        -H "Authorization: Bearer ${params.apiToken}" \\
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

    # Self-cleanup: ask the API to delete this VPS (no Hetzner token on the VM)
    # apiBaseUrl and apiToken are baked in at template generation time — no env file needed.
    # Always attempt cleanup regardless of metadata availability.
    echo "Requesting self-cleanup via API..."
    curl -sf --connect-timeout 5 --max-time 15 -X POST "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/cleanup" \\
      -H "Authorization: Bearer ${params.apiToken}" \\
      -H "Content-Type: application/json" || echo "Self-cleanup request failed (reconciler will handle)"
`;
}

// ---------------------------------------------------------------------------
// Upload VPS provisioning
// ---------------------------------------------------------------------------

export interface ProvisionUploadVpsParams {
  uploadJobId: string;
  nzbFileHash: string;
  s3Key: string;          // S3 key of the MKV file to upload
  apiBaseUrl: string;
  apiToken: string;
  hetznerApiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  /** Usenet upload providers (3 providers) */
  usenetProviders: Array<{
    host: string;
    port: number;
    username: string;
    password: string;
    ssl: boolean;
    connections: number;
  }>;
  dockerImage?: string;
}

/**
 * Generate cloud-init for an ephemeral upload VPS.
 * Similar to generateCloudInit but for the upload pipeline.
 */
export function generateUploadCloudInit(params: ProvisionUploadVpsParams): string {
  const dockerImage = params.dockerImage || "ghcr.io/ichbinder/openmedia-uploader:latest";
  const serverName = `upload-${params.nzbFileHash.substring(0, 8)}`;

  // Build ENV for the upload container
  const envLines = [
    `JOB_ID=${params.uploadJobId}`,
    `JOB_HASH=${params.nzbFileHash}`,
    `S3_KEY=${params.s3Key}`,
    `API_BASE_URL=${params.apiBaseUrl}`,
    `SERVICE_TOKEN=${params.apiToken}`,
    `S3_ACCESS_KEY=${params.s3AccessKey}`,
    `S3_SECRET_KEY=${params.s3SecretKey}`,
    `S3_ENDPOINT=${params.s3Endpoint}`,
    `S3_BUCKET=${params.s3Bucket}`,
    `HETZNER_API_TOKEN=${params.hetznerApiToken}`,
  ];

  // Add 3 provider configs
  for (let i = 0; i < Math.min(params.usenetProviders.length, 3); i++) {
    const p = params.usenetProviders[i];
    const n = i + 1;
    envLines.push(`USENET_HOST_${n}=${p.host}`);
    envLines.push(`USENET_PORT_${n}=${p.port}`);
    envLines.push(`USENET_USER_${n}=${p.username}`);
    envLines.push(`USENET_PASS_${n}=${p.password}`);
    envLines.push(`USENET_SSL_${n}=${p.ssl ? "1" : "0"}`);
    envLines.push(`USENET_CONNS_${n}=${p.connections}`);
  }

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
      curl -sf -X PATCH "${params.apiBaseUrl}/uploads/${params.uploadJobId}" \\
        -H "Authorization: Bearer ${params.apiToken}" \\
        -H "Content-Type: application/json" \\
        -d "{\\"status\\":\\"failed\\",\\"error\\":\\"$1\\"}" || true
    }

    if ! docker pull "${dockerImage}"; then
      fail_job "Docker pull failed: ${dockerImage}"
      exit 1
    fi

    # Run upload container — it handles everything internally:
    # S3→mkfifo→7z→PAR2→Nyuu→NZB→S3→API callback→self-delete
    if ! docker run --name openmedia-uploader \\
      --env-file /opt/openmedia-env \\
      -v /tmp:/opt/openmedia/tmp \\
      "${dockerImage}"; then
      fail_job "Upload container failed"
      exit 1
    fi

  - |
    EXIT_CODE=$?
    echo "openmedia-uploader exited with code $EXIT_CODE"
    rm -f /opt/openmedia-env

    # Self-delete via Hetzner metadata API
    SERVER_ID=$(curl -sf http://169.254.169.254/hetzner/v1/metadata/instance-id || echo "")
    if [ -n "$SERVER_ID" ]; then
      echo "Self-deleting VPS $SERVER_ID..."
      curl -sf -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \\
        -H "Authorization: Bearer ${params.hetznerApiToken}" || echo "Self-delete failed"
    fi
`;
}

/**
 * Provision an ephemeral VPS for uploading MKV to Usenet.
 */
export async function provisionUploadVps(
  params: ProvisionUploadVpsParams,
): Promise<HetznerCreateServerResult> {
  const cloudInit = generateUploadCloudInit(params);
  const serverName = `upload-${params.nzbFileHash.substring(0, 8)}-${Date.now()}`;

  console.log(`[hetzner] Provisioning upload VPS: ${serverName}`);

  const result = await createServer({
    name: serverName,
    serverType: "cax21",  // 4 vCPU, 8GB RAM, 80GB Disk — enough for 20GB+ temp
    userData: cloudInit,
    labels: {
      purpose: "openmedia-upload",
      uploadJobId: params.uploadJobId,
      nzbHash: params.nzbFileHash,
    },
  });

  return result;
}
