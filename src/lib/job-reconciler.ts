/**
 * Job Reconciler — detects and fixes stuck download jobs.
 *
 * Runs periodically to catch jobs where the VPS died without callback:
 *
 * 1. **Stale detection**: Jobs in non-terminal status (queued, provisioning,
 *    downloading, uploading) for longer than MAX_STALE_HOURS get checked.
 *
 * 2. **VPS health check**: For jobs with a Hetzner server ID, we verify
 *    the server still exists. If not → immediate failure.
 *
 * 3. **Hard timeout**: Jobs stuck longer than HARD_TIMEOUT_HOURS are failed
 *    regardless of VPS status (a download shouldn't take that long).
 *
 * 4. **Zombie VPS cleanup**: VPS servers without matching active jobs get deleted.
 */

import prisma from "./prisma.js";
import { getServer, deleteServer, listServers, isHetznerConfigured } from "./hetzner.js";
import { removeMapping } from "./caddy-mapping.js";
import { markJobFailed } from "./job-failure.js";

// ── Configuration ───────────────────────────────────────────

/** Hours after which a job is considered potentially stale.
 * Set low (10 min) so manually deleted VPS are detected quickly. */
const STALE_CHECK_HOURS = 10 / 60; // 10 minutes

/** Hours after which a job is force-failed regardless */
const HARD_TIMEOUT_HOURS = 4;

/** Interval between reconciliation runs (ms) */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Reconciliation Logic ────────────────────────────────────

export interface ReconcileResult {
  checked: number;
  failed: number;
  zombiesDeleted: number;
  details: string[];
}

/**
 * Run one reconciliation pass.
 *
 * Safe to call concurrently — uses CAS updates so no double-transition.
 */
export async function reconcileStaleJobs(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, failed: 0, zombiesDeleted: 0, details: [] };

  try {
    // Find non-terminal jobs
    const activeJobs = await prisma.downloadJob.findMany({
      where: {
        status: { in: ["queued", "provisioning", "downloading", "uploading"] },
      },
      include: {
        nzbFile: { select: { hash: true } },
      },
    });

    result.checked = activeJobs.length;

    const now = Date.now();

    for (const job of activeJobs) {
      const updatedAt = new Date(job.updatedAt).getTime();
      const ageHours = (now - updatedAt) / (1000 * 60 * 60);
      const hash = job.nzbFile.hash.slice(0, 12);

      // Hard timeout — fail regardless
      if (ageHours >= HARD_TIMEOUT_HOURS) {
        const failResult = await markJobFailed({
          jobId: job.id,
          error: `Timeout: Job steckte ${ageHours.toFixed(1)}h in Status '${job.status}' fest. Automatisch abgebrochen.`,
          source: "reconciler",
          expectedStatus: job.status,
        });

        if (failResult.changed) {
          result.failed++;
          const msg = `Hard timeout: job ${job.id.slice(0, 8)} (${hash}...) — ${ageHours.toFixed(1)}h in ${job.status}`;
          result.details.push(msg);
          console.log(`[reconciler] ${msg}`);
        }
        continue;
      }

      // Stale check — verify VPS still exists
      if (ageHours >= STALE_CHECK_HOURS && job.hetznerServerId && isHetznerConfigured()) {
        try {
          const server = await getServer(job.hetznerServerId);

          if (!server) {
            // VPS is gone but job still active → fail it
            const failResult = await markJobFailed({
              jobId: job.id,
              error: `Download-Server (${job.hetznerServerId}) existiert nicht mehr. Download abgebrochen.`,
              source: "reconciler",
              expectedStatus: job.status,
            });

            if (failResult.changed) {
              result.failed++;
              const msg = `VPS gone: job ${job.id.slice(0, 8)} (${hash}...) — server ${job.hetznerServerId} not found`;
              result.details.push(msg);
              console.log(`[reconciler] ${msg}`);
            }
          } else if (server.status === "off" || server.status === "deleting") {
            // VPS exists but is shutting down
            const failResult = await markJobFailed({
              jobId: job.id,
              error: `Download-Server ist ${server.status}. Download abgebrochen.`,
              source: "reconciler",
              expectedStatus: job.status,
            });

            if (failResult.changed) {
              result.failed++;
              const msg = `VPS ${server.status}: job ${job.id.slice(0, 8)} (${hash}...) — server ${job.hetznerServerId}`;
              result.details.push(msg);
              console.log(`[reconciler] ${msg}`);
            }
          }
        } catch (err: any) {
          // Hetzner API error — don't fail the job, just log
          console.warn(`[reconciler] Hetzner check failed for server ${job.hetznerServerId}: ${err.message}`);
        }
      }

      // Queued jobs without VPS that are stale → provisioning probably failed silently
      if (ageHours >= STALE_CHECK_HOURS && job.status === "queued") {
        const failResult = await markJobFailed({
          jobId: job.id,
          error: `Job blieb ${ageHours.toFixed(1)}h in 'queued' — Provisioning wurde nie gestartet.`,
          source: "reconciler",
          expectedStatus: "queued",
        });

        if (failResult.changed) {
          result.failed++;
          const msg = `Stale queued: job ${job.id.slice(0, 8)} (${hash}...) — ${ageHours.toFixed(1)}h`;
          result.details.push(msg);
          console.log(`[reconciler] ${msg}`);
        }
      }
    }

    // ── Zombie VPS cleanup ──────────────────────────────────
    if (isHetznerConfigured()) {
      try {
        const servers = await listServers("purpose=openmedia-download");

        for (const server of servers) {
          const jobId = server.labels["job-id"];
          if (!jobId) continue;

          // Check if the job is still active
          const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });

          // If job doesn't exist or is terminal → VPS is a zombie
          if (!job || job.status === "completed" || job.status === "failed") {
            try {
              const deleted = await deleteServer(server.id);
              if (deleted) {
                result.zombiesDeleted++;
                const msg = `Zombie VPS deleted: ${server.name} (id: ${server.id}) — job ${jobId?.slice(0, 8) || "?"}`;
                result.details.push(msg);
                console.log(`[reconciler] ${msg}`);

                // Clean up Caddy reverse proxy mapping
                try {
                  await removeMapping(server.name);
                } catch {
                  // Best-effort — mapping may not exist
                }
              }
            } catch (delErr: any) {
              console.warn(`[reconciler] Zombie delete failed: ${server.id} — ${delErr.message}`);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[reconciler] Zombie scan failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error("[reconciler] Reconciliation failed:", err);
  }

  return result;
}

// ── Scheduler ───────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic reconciler.
 *
 * Runs immediately once, then every RECONCILE_INTERVAL_MS.
 */
export function startReconciler(): void {
  if (intervalHandle) {
    console.log("[reconciler] Already running.");
    return;
  }

  console.log(`[reconciler] Starting (check every ${RECONCILE_INTERVAL_MS / 1000}s, stale=${STALE_CHECK_HOURS}h, timeout=${HARD_TIMEOUT_HOURS}h)`);

  // Run once immediately
  reconcileStaleJobs().then((r) => {
    if (r.failed > 0 || r.zombiesDeleted > 0) {
      console.log(`[reconciler] Initial run: ${r.failed} jobs failed, ${r.zombiesDeleted} zombies cleaned`);
    }
  });

  intervalHandle = setInterval(async () => {
    const r = await reconcileStaleJobs();
    if (r.failed > 0 || r.zombiesDeleted > 0) {
      console.log(`[reconciler] Periodic: ${r.failed} jobs failed, ${r.zombiesDeleted} zombies cleaned`);
    }
  }, RECONCILE_INTERVAL_MS);
}

/**
 * Stop the periodic reconciler.
 */
export function stopReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log("[reconciler] Stopped.");
  }
}
