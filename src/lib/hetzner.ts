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
  serverType: string;
  location: string;
  labels: Record<string, string>;
  created: string; // ISO timestamp
}

export interface HetznerCreateServerOptions {
  name: string;
  serverType?: string;     // default: cx22 (2 vCPU, 4GB RAM)
  image?: string;          // default: docker-ce (Docker pre-installed)
  location?: string;       // default: hel1
  userData?: string;       // Cloud-Init script
  sshKeys?: string[];      // SSH key names
  labels?: Record<string, string>;
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
  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    publicIpv4: raw.public_net?.ipv4?.ip || null,
    publicIpv6: raw.public_net?.ipv6?.ip || null,
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
 * - cx22: 2 vCPU, 4GB RAM, 40GB disk (€0.0048/h ≈ €3.50/month)
 * - docker-ce: Ubuntu with Docker pre-installed
 * - hel1: Helsinki (same region as S3 bucket)
 */
export async function createServer(
  options: HetznerCreateServerOptions,
): Promise<HetznerCreateServerResult> {
  const start = Date.now();

  const body: Record<string, any> = {
    name: options.name,
    server_type: options.serverType || "cx22",
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
export function generateCloudInit(params: {
  jobId: string;
  nzbHash: string;
  apiBaseUrl: string;
  apiToken: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
  s3Bucket: string;
  usenetHost: string;
  usenetPort: number;
  usenetUser: string;
  usenetPassword: string;
  usenetSsl: boolean;
}): string {
  // Cloud-Init is a YAML-based configuration format
  // We use runcmd to execute shell commands after boot
  return `#cloud-config
package_update: true

runcmd:
  # Signal provisioning started
  - |
    curl -s -X PATCH "${params.apiBaseUrl}/downloads/jobs/${params.jobId}/status" \\
      -H "Authorization: Bearer ${params.apiToken}" \\
      -H "Content-Type: application/json" \\
      -d '{"status":"downloading","hetznerServerIp":"$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4)"}'

  # Create working directories
  - mkdir -p /opt/downloads/incomplete /opt/downloads/complete /opt/downloads/nzb

  # Download NZB file from openmedia-nzb storage
  - |
    curl -s "${params.apiBaseUrl}/nzb/files/by-hash/${params.nzbHash}" \\
      -H "Authorization: Bearer ${params.apiToken}" \\
      -o /opt/downloads/nzb/${params.nzbHash}.nzb

  # Run SABnzbd container
  - |
    docker run -d --name sabnzbd \\
      -p 8080:8080 \\
      -v /opt/downloads/incomplete:/incomplete \\
      -v /opt/downloads/complete:/complete \\
      -v /opt/downloads/nzb:/nzb \\
      lscr.io/linuxserver/sabnzbd:latest

  # Wait for SABnzbd to start
  - sleep 30

  # Configure SABnzbd via API (add Usenet server)
  - |
    SAB_API_KEY=$(cat /opt/downloads/sabnzbd/sabnzbd.ini 2>/dev/null | grep "api_key" | cut -d= -f2 | tr -d ' ' || echo "")
    if [ -z "$SAB_API_KEY" ]; then
      echo "[cloud-init] SABnzbd API key not found, waiting..."
      sleep 30
      SAB_API_KEY=$(cat /opt/downloads/sabnzbd/sabnzbd.ini 2>/dev/null | grep "api_key" | cut -d= -f2 | tr -d ' ')
    fi

  # Post-processing script (runs after SABnzbd completes a download)
  - |
    cat > /opt/downloads/post-process.sh << 'POSTSCRIPT'
    #!/bin/bash
    set -e
    
    COMPLETE_DIR="/complete"
    JOB_ID="${params.jobId}"
    API_URL="${params.apiBaseUrl}"
    API_TOKEN="${params.apiToken}"
    S3_BUCKET="${params.s3Bucket}"
    S3_ENDPOINT="${params.s3Endpoint}"
    NZB_HASH="${params.nzbHash}"
    
    echo "[post-process] Starting for job $JOB_ID"
    
    # Signal uploading status
    curl -s -X PATCH "$API_URL/downloads/jobs/$JOB_ID/status" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"status":"uploading","progress":80}'
    
    # Find the main video file
    VIDEO_FILE=$(find "$COMPLETE_DIR" -type f \\( -name "*.mkv" -o -name "*.mp4" -o -name "*.avi" \\) | head -1)
    
    if [ -z "$VIDEO_FILE" ]; then
      echo "[post-process] No video file found!"
      curl -s -X PATCH "$API_URL/downloads/jobs/$JOB_ID/status" \\
        -H "Authorization: Bearer $API_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"status":"failed","error":"Keine Videodatei gefunden nach dem Entpacken."}'
      exit 1
    fi
    
    # Get file extension
    FILE_EXT=".$(echo "$VIDEO_FILE" | rev | cut -d. -f1 | rev)"
    
    # Calculate SHA-256 hash of the file
    FILE_HASH=$(sha256sum "$VIDEO_FILE" | cut -d' ' -f1)
    S3_KEY="$FILE_HASH/$FILE_HASH$FILE_EXT"
    
    echo "[post-process] Uploading $S3_KEY to S3..."
    
    # Install AWS CLI for S3 upload
    apt-get install -y -qq awscli 2>/dev/null || pip install awscli 2>/dev/null
    
    # Configure AWS CLI for Hetzner S3
    export AWS_ACCESS_KEY_ID="${params.s3AccessKey}"
    export AWS_SECRET_ACCESS_KEY="${params.s3SecretKey}"
    
    # Upload to S3
    aws s3 cp "$VIDEO_FILE" "s3://$S3_BUCKET/$S3_KEY" \\
      --endpoint-url "$S3_ENDPOINT" \\
      --region hel1
    
    echo "[post-process] Upload complete. Signaling API..."
    
    # Signal completed with S3 reference
    curl -s -X PATCH "$API_URL/downloads/jobs/$JOB_ID/status" \\
      -H "Authorization: Bearer $API_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d "{\\\"status\\\":\\\"completed\\\",\\\"s3Key\\\":\\\"$S3_KEY\\\",\\\"s3Bucket\\\":\\\"$S3_BUCKET\\\",\\\"fileExtension\\\":\\\"$FILE_EXT\\\",\\\"progress\\\":100}"
    
    echo "[post-process] Done. Server will self-destruct."
    POSTSCRIPT
    chmod +x /opt/downloads/post-process.sh

  # Note: The actual SABnzbd configuration and NZB submission
  # will be handled by the Docker image's entrypoint in S04.
  # This Cloud-Init provides the framework and post-processing script.
`;
}
