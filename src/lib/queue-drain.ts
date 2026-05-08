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

  // Atomic CAS claim: find + claim in one step to prevent race conditions
  const candidates = await prisma.downloadJob.findMany({
    where: { status: "queued", hetznerServerId: null },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  if (candidates.length === 0) return;
  const candidate = candidates[0];

  // Atomic claim — updateMany returns count; if 0, another drain already claimed it
  const claimed = await prisma.downloadJob.updateMany({
    where: { id: candidate.id, status: "queued", hetznerServerId: null },
    data: { status: "provisioning" },
  });

  if (claimed.count === 0) return;

  console.log(`[queue-drain] Provisioning queued download job ${candidate.id}`);
  try {
    await provisionDownload(candidate.id);
  } catch (err) {
    // Reset to queued so the job can be retried on next drain
    await prisma.downloadJob.updateMany({
      where: { id: candidate.id, status: "provisioning" },
      data: { status: "queued" },
    }).catch(() => {});
    throw err;
  }
}

async function drainUploadQueue(): Promise<void> {
  const gate = await canProvision("upload");
  if (!gate.allowed) return;

  // Atomic CAS claim: find + claim in one step to prevent race conditions
  const candidates = await prisma.uploadJob.findMany({
    where: { status: "queued", hetznerServerId: null },
    orderBy: { createdAt: "asc" },
    take: 1,
    include: { nzbFile: true },
  });

  if (candidates.length === 0) return;
  const candidate = candidates[0];

  const claimed = await prisma.uploadJob.updateMany({
    where: { id: candidate.id, status: "queued", hetznerServerId: null },
    data: { status: "provisioning" },
  });

  if (claimed.count === 0) return;

  console.log(`[queue-drain] Provisioning queued upload job ${candidate.id}`);

  // Inline upload provisioning (mirrors uploads.ts POST logic)
  const { isHetznerConfigured, provisionUploadVps, deleteServer } = await import("./hetzner.js");
  if (!isHetznerConfigured()) {
    await resetToQueued("upload", candidate.id);
    return;
  }

  const { getUploadVpsConfig } = await import("./vps-config.js");
  const uploadConfig = await getUploadVpsConfig();
  if (!uploadConfig) {
    console.warn("[queue-drain] Upload config incomplete — skipping");
    await resetToQueued("upload", candidate.id);
    return;
  }

  const { generateServiceToken, storeServiceToken } = await import("./service-token.js");
  const { plaintext: serviceToken, hash: tokenHash } = generateServiceToken();

  const serverName = `up-${candidate.nzbFile.hash.substring(0, 8)}`;
  let provisionedServerId: number | null = null;

  try {
    await storeServiceToken(tokenHash, candidate.id, "upload");

    const result = await provisionUploadVps({
      jobId: candidate.id,
      nzbFileHash: candidate.nzbFile.hash,
      apiBaseUrl: uploadConfig.apiBaseUrl,
      serviceToken,
      dockerImage: uploadConfig.dockerImage,
      serverName,
    });
    provisionedServerId = result.server.id;

    const resolvedServerIp = result.server.privateIp || result.server.publicIpv4;

    await prisma.uploadJob.update({
      where: { id: candidate.id },
      data: {
        status: "running",
        hetznerServerId: result.server.id,
        hetznerServerIp: resolvedServerIp,
        startedAt: new Date(),
      },
    });

    console.log(`[queue-drain] Upload VPS created: ${serverName} (ID: ${result.server.id})`);
  } catch (err) {
    console.error(`[queue-drain] Upload VPS creation failed for job ${candidate.id}:`, (err as Error).message);
    // Rollback: delete VPS if provisioned, clean up token, reset to queued
    if (provisionedServerId !== null) {
      try {
        await deleteServer(provisionedServerId);
      } catch (delErr) {
        console.error(`[queue-drain] Failed to delete orphaned VPS ${provisionedServerId}:`, (delErr as Error).message);
      }
    }
    try {
      const { deleteServiceTokens } = await import("./service-token.js");
      await deleteServiceTokens(candidate.id);
    } catch { /* non-fatal */ }
    await resetToQueued("upload", candidate.id);
  }
}

/** Reset a claimed job back to queued (non-fatal). */
async function resetToQueued(type: "download" | "upload", jobId: string): Promise<void> {
  try {
    if (type === "download") {
      await prisma.downloadJob.updateMany({
        where: { id: jobId, status: "provisioning" },
        data: { status: "queued" },
      });
    } else {
      await prisma.uploadJob.updateMany({
        where: { id: jobId, status: "provisioning" },
        data: { status: "queued" },
      });
    }
  } catch (err) {
    console.error(`[queue-drain] Failed to reset ${type} job ${jobId} to queued:`, (err as Error).message);
  }
}
