import prisma from "./prisma.js";
import type { Prisma } from "../../generated/client/index.js";

const BROKEN_THRESHOLD = 3;

interface MarkJobFailedOptions {
  /** Job ID to fail */
  jobId: string;
  /** Error message to store on the job */
  error: string;
  /** Source label for logging (e.g. "provisioner", "reconciler", "manual") */
  source: string;
  /** Only fail if the job is currently in this status (CAS — prevents double-failure) */
  expectedStatus?: string;
  /** Additional fields to set on the DownloadJob (e.g. progress, hetznerServerId) */
  extraJobUpdate?: Prisma.DownloadJobUpdateManyMutationInput;
}

export interface MarkJobFailedResult {
  /** True if the job state was actually changed (CAS succeeded) */
  changed: boolean;
  /** New failedAttempts count after increment (only set when changed=true) */
  failedAttempts?: number;
  /** True if this failure pushed the NzbFile to broken status */
  brokenNow?: boolean;
}

/**
 * Atomically mark a download job as failed and increment the NzbFile's
 * failedAttempts counter. Auto-marks the NzbFile as broken at 3+ failures.
 *
 * Uses optimistic concurrency control (CAS) on `status` to prevent
 * double-counting when multiple code paths race to fail the same job.
 *
 * Used by:
 * - provisioner.ts (Hetzner / Local Docker failures)
 * - job-reconciler.ts (timeouts, stale jobs, vanished VPS)
 * - downloads.ts (manual status updates from /jobs/:id)
 */
export async function markJobFailed(options: MarkJobFailedOptions): Promise<MarkJobFailedResult> {
  const { jobId, error, source, expectedStatus, extraJobUpdate } = options;

  return prisma.$transaction(async (tx) => {
    // CAS: only update if status matches expectedStatus (or any non-terminal status)
    const whereClause: Prisma.DownloadJobUpdateManyArgs["where"] = expectedStatus
      ? { id: jobId, status: expectedStatus }
      : { id: jobId, status: { notIn: ["completed", "failed"] } };

    const cas = await tx.downloadJob.updateMany({
      where: whereClause,
      data: {
        ...extraJobUpdate,
        status: "failed",
        error,
        completedAt: new Date(),
      },
    });

    if (cas.count === 0) {
      // Already in terminal state or status changed — skip increment
      return { changed: false };
    }

    // Look up the job to get nzbFileId
    const job = await tx.downloadJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { nzbFileId: true },
    });

    // Increment failedAttempts atomically
    const updatedNzb = await tx.nzbFile.update({
      where: { id: job.nzbFileId },
      data: { failedAttempts: { increment: 1 } },
    });

    let brokenNow = false;

    // Auto-mark as broken at threshold
    if (updatedNzb.failedAttempts >= BROKEN_THRESHOLD && updatedNzb.status !== "broken") {
      const reason = `Download ${updatedNzb.failedAttempts}x fehlgeschlagen: ${error.slice(0, 200)}`;
      await tx.nzbFile.update({
        where: { id: job.nzbFileId },
        data: { status: "broken", brokenReason: reason },
      });
      brokenNow = true;
      console.log(
        `[${source}] NZB auto-broken: ${updatedNzb.hash.slice(0, 12)}... (${updatedNzb.failedAttempts} failures)`
      );
    }

    console.log(
      `[${source}] Job failed: ${jobId.slice(0, 8)} → attempt ${updatedNzb.failedAttempts}/${BROKEN_THRESHOLD}`
    );

    return {
      changed: true,
      failedAttempts: updatedNzb.failedAttempts,
      brokenNow,
    };
  });
}
