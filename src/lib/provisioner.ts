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
import { isHetznerConfigured, createServer, generateCloudInit } from "./hetzner.js";
import { markJobFailed } from "./job-failure.js";
import { addMapping } from "./caddy-mapping.js";
import { getDownloadVpsConfig, canProvision } from "./vps-config.js";
import { generateServiceToken, storeServiceToken, deleteServiceTokens } from "./service-token.js";

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

  // Defensive: NzbFile without movieId means the upload is still in review.
  // The /request path should never route such jobs here, but if something slips
  // through (e.g. manual DB edit), skip cleanly rather than crash or start a
  // download without a movie context.
  if (!job.nzbFile.movieId || !job.nzbFile.movie) {
    console.log(
      `[provision] Skipping job ${jobId}: NzbFile ${job.nzbFile.hash.slice(0, 12)}... has no movie (needs_review)`
    );
    return;
  }

  // Concurrency gate: check VPS limits before provisioning (Hetzner only)
  if (mode === "hetzner") {
    const gate = await canProvision("download");
    if (!gate.allowed) {
      console.log(`[provision] Skipping job ${jobId}: ${gate.reason} — job stays queued`);
      return;
    }
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
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
    return;
  }

  // Resolve config from DB config store (preferred) or ENV (fallback)
  // Still needed for apiBaseUrl and dockerImage
  const config = await getDownloadVpsConfig();
  if (!config) {
    const error = "Missing download VPS config (neither DB config store nor ENV vars are sufficient)";
    console.error(`[provision] ${error}`);
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
    return;
  }

  // Generate per-VPS service token — plaintext goes to cloud-init, hash stored in DB
  const { plaintext: serviceTokenPlaintext, hash: serviceTokenHash } = generateServiceToken();
  try {
    await storeServiceToken(serviceTokenHash, job.id, "download");
    console.log(`[provision] ServiceToken created for job ${job.id}`);
  } catch (err: any) {
    const error = `ServiceToken storage failed: ${err.message}`;
    console.error(`[provision] ${error}`);
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
    return;
  }

  const serverName = `dl-${job.id.slice(0, 8)}`;

  // Cloud-init carries 3 ENV vars + bootstrap.sh — VPS fetches all config (incl. VPN) at boot
  const cloudInit = generateCloudInit({
    jobId: job.id,
    apiBaseUrl: config.apiBaseUrl,
    serviceToken: serviceTokenPlaintext,
    dockerImage: config.dockerImage,
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
    // Clean up orphaned ServiceToken — VPS was never created so token is useless
    try {
      await deleteServiceTokens(job.id);
      console.log(`[provision] Orphaned ServiceToken cleaned up for job ${job.id}`);
    } catch (cleanupErr: any) {
      console.error(`[provision] ServiceToken cleanup failed: ${cleanupErr.message}`);
    }

    const error = `Hetzner VPS creation failed: ${err.message}`;
    console.error(`[provision] ${error}`);
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
  }
}

// ── Local Docker Provisioning (Dev only) ────────────────────

async function provisionLocalDocker(job: any): Promise<void> {
  const containerName = `dl-${job.id.slice(0, 8)}`;

  const config = await getDownloadVpsConfig();
  if (!config) {
    const error = "Missing download config (neither DB config store nor ENV vars are sufficient)";
    console.error(`[provision] ${error}`);
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
    return;
  }

  // Generate per-container service token (same pattern as Hetzner path)
  const { plaintext: serviceTokenPlaintext, hash: serviceTokenHash } = generateServiceToken();
  try {
    await storeServiceToken(serviceTokenHash, job.id, "download");
    console.log(`[provision] ServiceToken created for local job ${job.id}`);
  } catch (err: any) {
    const error = `ServiceToken storage failed: ${err.message}`;
    console.error(`[provision] ${error}`);
    await markJobFailed({ jobId: job.id, error, source: "provision", expectedStatus: "provisioning" });
    return;
  }

  // Only 3 ENV vars — container fetches config at boot via bootstrap API
  const envVars = [
    `JOB_ID=${job.id}`,
    `API_BASE_URL=${config.apiBaseUrl}`,
    `SERVICE_TOKEN=${serviceTokenPlaintext}`,
  ];

  const envFlags = envVars.map((v) => `-e "${v}"`).join(" \\\n    ");
  const image = config.dockerImage;

  const dockerCmd = `docker run -d --name ${containerName} \
    --add-host=host.docker.internal:host-gateway \
    ${envFlags} \
    ${image}`;

  console.log(`[provision] Local container: ${containerName}`);

  exec(dockerCmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`[provision] Docker run failed:`, stderr || err.message);
      markJobFailed({
        jobId: job.id,
        error: `Container start failed: ${stderr || err.message}`,
        source: "provision",
        expectedStatus: "provisioning",
      }).catch((e) => console.error("[provision] markJobFailed failed:", e));
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
