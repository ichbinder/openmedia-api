/**
 * Download Provisioner
 *
 * Automatically provisions a download environment after a job is created.
 *
 * - Production (AUTO_PROVISION=hetzner): Creates a Hetzner Cloud VPS
 *   that runs the openmedia-downloader container, then self-destructs.
 * - Development (AUTO_PROVISION=local): Runs the container locally via Docker.
 * - Disabled: AUTO_PROVISION=false
 */

import { exec } from "node:child_process";
import prisma from "./prisma.js";
import { isHetznerConfigured, createServer, generateCloudInit, type UsenetServer } from "./hetzner.js";
import { parseUsenetServersFromEnv } from "./usenet-config.js";
import { addMapping } from "./caddy-mapping.js";

type ProvisionMode = "hetzner" | "local" | "false";

function getProvisionMode(): ProvisionMode {
  const mode = process.env.AUTO_PROVISION || "hetzner";
  if (mode === "false" || mode === "local" || mode === "hetzner") {
    return mode;
  }
  console.error(`[provision] Unknown AUTO_PROVISION value: "${mode}" — must be "hetzner", "local", or "false". Defaulting to "false" (disabled).`);
  return "false";
}

/**
 * Provision a download for the given job.
 * Called automatically after job creation.
 */
export async function provisionDownload(jobId: string): Promise<void> {
  const mode = getProvisionMode();

  if (mode === "false") {
    console.log(`[provision] Disabled (AUTO_PROVISION=false)`);
    return;
  }

  const job = await prisma.downloadJob.findUnique({
    where: { id: jobId },
    include: { nzbFile: { include: { movie: true } } },
  });

  if (!job || job.status !== "queued") {
    console.log(`[provision] Skipping job ${jobId}: not queued (${job?.status})`);
    return;
  }

  // CAS: set to provisioning
  const updated = await prisma.downloadJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: { status: "provisioning", startedAt: new Date() },
  });

  if (updated.count === 0) {
    console.log(`[provision] CAS failed for job ${jobId}`);
    return;
  }

  console.log(`[provision] Mode: ${mode} — ${job.nzbFile.movie.titleEn} (${job.nzbFile.hash.slice(0, 12)}...)`);

  if (mode === "hetzner") {
    await provisionHetznerVPS(job);
  } else {
    await provisionLocalDocker(job);
  }
}

// ── Hetzner Cloud VPS Provisioning ──────────────────────────

async function provisionHetznerVPS(job: any): Promise<void> {
  if (!isHetznerConfigured()) {
    const error = "AUTO_PROVISION=hetzner but HETZNER_API_TOKEN is not configured";
    console.error(`[provision] ${error}`);
    await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "provisioning" },
      data: { status: "failed", error },
    });
    return;
  }

  // Validate required env vars
  const required = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_BUCKET", "API_BASE_URL", "NZB_SERVICE_URL", "SERVICE_API_TOKEN"];
  const missing = required.filter((v) => !process.env[v]);
  // At least one Usenet source required
  if (!process.env.USENET_SERVERS && !process.env.USENET_HOST) {
    missing.push("USENET_SERVERS or USENET_HOST");
  }
  if (missing.length > 0) {
    const error = `Missing config: ${missing.join(", ")}`;
    console.error(`[provision] ${error}`);
    await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "provisioning" },
      data: { status: "failed", error },
    });
    return;
  }

  const nzbServiceUrl = process.env.NZB_SERVICE_URL!;
  const dockerImage = process.env.DOWNLOADER_DOCKER_IMAGE || "ghcr.io/ichbinder/openmedia-downloader:latest";

  const serverName = `dl-${job.id.slice(0, 8)}`;

  const cloudInit = generateCloudInit({
    jobId: job.id,
    nzbHash: job.nzbFile.hash,
    nzbUrl: `${nzbServiceUrl}/nzb/${job.nzbFile.hash}.nzb`,
    apiBaseUrl: process.env.API_BASE_URL!,
    apiToken: process.env.SERVICE_API_TOKEN!,
    s3AccessKey: process.env.S3_ACCESS_KEY!,
    s3SecretKey: process.env.S3_SECRET_KEY!,
    s3Endpoint: process.env.S3_ENDPOINT!,
    s3Bucket: process.env.S3_BUCKET!,
    s3Region: process.env.S3_REGION || "hel1",
    usenetServers: parseUsenetServersFromEnv(),
    dockerImage,
    serverName,
  });
  const rawNetworkId = process.env.HETZNER_NETWORK_ID;
  const networkId = rawNetworkId ? parseInt(rawNetworkId, 10) : undefined;
  if (rawNetworkId && (!networkId || isNaN(networkId))) {
    console.warn(`[provision] HETZNER_NETWORK_ID is not a valid number: "${rawNetworkId}" — VPS will not be attached to private network`);
  }

  try {
    const result = await createServer({
      name: serverName,
      userData: cloudInit,
      sshKeys: process.env.HETZNER_SSH_KEY_NAME ? [process.env.HETZNER_SSH_KEY_NAME] : undefined,
      labels: { "job-id": job.id, purpose: "openmedia-download" },
      networks: networkId ? [networkId] : undefined,
    });

    // Update job with server info (prefer private IP for internal routing, keep public for reference)
    await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "provisioning" },
      data: {
        hetznerServerId: result.server.id,
        hetznerServerIp: result.server.privateIp || result.server.publicIpv4 || null,
      },
    });

    // Register Caddy reverse proxy mapping for SABnzbd UI access
    if (result.server.privateIp) {
      try {
        await addMapping(serverName, result.server.privateIp);
      } catch (mappingErr: any) {
        // Non-fatal: download works without UI access
        console.error(`[provision] Caddy mapping failed (non-fatal): ${mappingErr.message}`);
      }
    }

    console.log(`[provision] Hetzner VPS created: ${serverName} (ID: ${result.server.id}, public: ${result.server.publicIpv4}, private: ${result.server.privateIp})`);
  } catch (err: any) {
    const error = `Hetzner VPS creation failed: ${err.message}`;
    console.error(`[provision] ${error}`);
    await prisma.downloadJob.updateMany({
      where: { id: job.id, status: "provisioning" },
      data: { status: "failed", error },
    });
  }
}

// ── Local Docker Provisioning (Dev only) ────────────────────

async function provisionLocalDocker(job: any): Promise<void> {
  const containerName = `dl-${job.id.slice(0, 8)}`;
  const hash = job.nzbFile.hash;

  const servers = parseUsenetServersFromEnv();
  const envVars = [
    `JOB_ID=${job.id}`,
    `JOB_HASH=${hash}`,
    `NZB_URL=${process.env.NZB_SERVICE_URL}/nzb/${hash}.nzb`,
    `API_BASE_URL=${process.env.API_BASE_URL}`,
    `SERVICE_TOKEN=${process.env.SERVICE_API_TOKEN || ""}`,
    `USENET_SERVERS=${JSON.stringify(servers)}`,
    `S3_ACCESS_KEY=${process.env.S3_ACCESS_KEY}`,
    `S3_SECRET_KEY=${process.env.S3_SECRET_KEY}`,
    `S3_ENDPOINT=${process.env.S3_ENDPOINT}`,
    `S3_BUCKET=${process.env.S3_BUCKET}`,
    `S3_REGION=${process.env.S3_REGION || "hel1"}`,
  ];

  const envFlags = envVars.map((v) => `-e "${v}"`).join(" \\\n    ");
  const image = process.env.DOWNLOADER_DOCKER_IMAGE || "openmedia-downloader:local";

  const dockerCmd = `docker run -d --name ${containerName} \
    --add-host=host.docker.internal:host-gateway \
    ${envFlags} \
    ${image}`;

  console.log(`[provision] Local container: ${containerName}`);

  exec(dockerCmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`[provision] Docker run failed:`, stderr || err.message);
      prisma.downloadJob.updateMany({
        where: { id: job.id, status: "provisioning" },
        data: { status: "failed", error: `Container start failed: ${stderr || err.message}` },
      }).catch((e) => console.error("[provision] Status update failed:", e));
      return;
    }

    console.log(`[provision] Container started: ${stdout.trim().slice(0, 12)}`);

    // Start submit-and-monitor after SABnzbd is ready
    setTimeout(() => {
      exec(
        `docker exec -d ${containerName} /bin/bash -c "/opt/openmedia/submit-and-monitor.sh > /var/log/submit-monitor.log 2>&1"`,
        (err2) => {
          if (err2) {
            console.error(`[provision] Submit script failed:`, err2.message);
          } else {
            console.log(`[provision] Submit script started in ${containerName}`);
          }
        }
      );
    }, 30000);
  });
}
