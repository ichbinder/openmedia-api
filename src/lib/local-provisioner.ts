/**
 * Local Download Provisioner
 *
 * Starts a local Docker container to download a film instead of
 * creating a Hetzner VPS. Used for development and testing.
 *
 * In production, this is replaced by Hetzner Cloud VPS provisioning.
 */

import { exec } from "node:child_process";
import prisma from "./prisma.js";

export async function provisionLocalDownload(jobId: string): Promise<void> {
  const job = await prisma.downloadJob.findUnique({
    where: { id: jobId },
    include: { nzbFile: { include: { movie: true } } },
  });

  if (!job || job.status !== "queued") {
    console.log(`[local-provision] Skipping job ${jobId}: not queued (${job?.status})`);
    return;
  }

  // Update status to provisioning
  const updated = await prisma.downloadJob.updateMany({
    where: { id: jobId, status: "queued" },
    data: { status: "provisioning", startedAt: new Date() },
  });

  if (updated.count === 0) {
    console.log(`[local-provision] CAS failed for job ${jobId}`);
    return;
  }

  const containerName = `dl-${jobId.slice(0, 8)}`;
  const hash = job.nzbFile.hash;
  const nzbFileId = job.nzbFile.id;

  // Build env vars for the container
  const envVars = [
    `JOB_ID=${jobId}`,
    `JOB_HASH=${hash}`,
    `NZB_URL=${process.env.NZB_SERVICE_URL}/nzb/${hash}.nzb`,
    `API_BASE_URL=${process.env.API_BASE_URL}`,
    `SERVICE_TOKEN=${process.env.SERVICE_API_TOKEN || ""}`,
    `USENET_HOST=${process.env.USENET_HOST}`,
    `USENET_PORT=${process.env.USENET_PORT || "563"}`,
    `USENET_USER=${process.env.USENET_USER}`,
    `USENET_PASSWORD=${process.env.USENET_PASSWORD}`,
    `USENET_SSL=${process.env.USENET_SSL || "1"}`,
    `USENET_CONNECTIONS=${process.env.USENET_CONNECTIONS || "10"}`,
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

  console.log(`[local-provision] Starting container ${containerName} for ${job.nzbFile.movie.titleEn} (${hash.slice(0, 12)}...)`);

  exec(dockerCmd, (err, stdout, stderr) => {
    if (err) {
      console.error(`[local-provision] Docker run failed:`, stderr || err.message);
      // Set job to failed
      prisma.downloadJob.updateMany({
        where: { id: jobId, status: "provisioning" },
        data: { status: "failed", error: `Container start failed: ${stderr || err.message}` },
      }).catch((e) => console.error("[local-provision] Failed to update job status:", e));
      return;
    }

    const containerId = stdout.trim().slice(0, 12);
    console.log(`[local-provision] Container started: ${containerId}`);

    // Start submit-and-monitor.sh after SABnzbd is ready
    setTimeout(() => {
      exec(
        `docker exec -d ${containerName} /bin/bash -c "/opt/openmedia/submit-and-monitor.sh > /var/log/submit-monitor.log 2>&1"`,
        (err2) => {
          if (err2) {
            console.error(`[local-provision] Failed to start submit script:`, err2.message);
          } else {
            console.log(`[local-provision] Submit script started in ${containerName}`);
          }
        }
      );
    }, 30000); // Wait 30s for SABnzbd to start
  });
}
