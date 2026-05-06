/**
 * Queue Drain — automatically provisions the next queued job when a VPS slot frees up.
 *
 * Called after VPS deletion (download cleanup, upload completion/failure, upload cleanup).
 * Non-blocking: errors are logged but never thrown.
 */

import prisma from "./prisma.js";
import { canProvision } from "./vps-config.js";
import { provisionDownload } from "./provisioner.js";

/**
 * Try to provision the next queued job(s) if VPS slots are available.
 * Fire-and-forget — safe to call without awaiting.
 */
export async function drainQueue(): Promise<void> {
  try {
    await drainDownloadQueue();
  } catch (err) {
    console.error("[queue-drain] Download drain failed:", (err as Error).message);
  }

  try {
    await drainUploadQueue();
  } catch (err) {
    console.error("[queue-drain] Upload drain failed:", (err as Error).message);
  }
}

async function drainDownloadQueue(): Promise<void> {
  const gate = await canProvision("download");
  if (!gate.allowed) return;

  // Find oldest queued download job without a server
  const nextJob = await prisma.downloadJob.findFirst({
    where: {
      status: "queued",
      hetznerServerId: null,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!nextJob) return;

  console.log(`[queue-drain] Provisioning queued download job ${nextJob.id}`);
  // provisionDownload handles its own error handling (markJobFailed etc.)
  await provisionDownload(nextJob.id);
}

async function drainUploadQueue(): Promise<void> {
  const gate = await canProvision("upload");
  if (!gate.allowed) return;

  // Find oldest queued upload job without a server
  const nextJob = await prisma.uploadJob.findFirst({
    where: {
      status: "queued",
      hetznerServerId: null,
    },
    orderBy: { createdAt: "asc" },
    include: { nzbFile: true },
  });

  if (!nextJob) return;

  console.log(`[queue-drain] Provisioning queued upload job ${nextJob.id}`);

  // Inline upload provisioning (mirrors uploads.ts POST logic)
  const { isHetznerConfigured, provisionUploadVps } = await import("./hetzner.js");
  if (!isHetznerConfigured()) return;

  const { getUploadVpsConfig } = await import("./vps-config.js");
  const uploadConfig = await getUploadVpsConfig();
  if (!uploadConfig) {
    console.warn("[queue-drain] Upload config incomplete — skipping");
    return;
  }

  const { generateServiceToken, storeServiceToken } = await import("./service-token.js");
  const { plaintext: serviceToken, hash: tokenHash } = generateServiceToken();
  await storeServiceToken(tokenHash, nextJob.id, "upload");

  const serverName = `up-${nextJob.nzbFile.hash.substring(0, 8)}`;

  try {
    const result = await provisionUploadVps({
      jobId: nextJob.id,
      nzbFileHash: nextJob.nzbFile.hash,
      apiBaseUrl: uploadConfig.apiBaseUrl,
      serviceToken,
      dockerImage: uploadConfig.dockerImage,
      serverName,
    });

    const resolvedServerIp = result.server.privateIp || result.server.publicIpv4;

    await prisma.uploadJob.update({
      where: { id: nextJob.id },
      data: {
        status: "running",
        hetznerServerId: result.server.id,
        hetznerServerIp: resolvedServerIp,
        startedAt: new Date(),
      },
    });

    console.log(`[queue-drain] Upload VPS created: ${serverName} (ID: ${result.server.id})`);
  } catch (err) {
    console.error(`[queue-drain] Upload VPS creation failed for job ${nextJob.id}:`, (err as Error).message);
    // Don't mark as failed — job stays queued for next drain attempt
  }
}
