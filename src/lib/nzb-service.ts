/**
 * Thin client for the openmedia-nzb service (nginx + Node.js running on LXC).
 *
 * The NZB service holds the physical {hash}.nzb files that the download VPS
 * fetches during provisioning. Two operations are currently needed:
 *
 * - `storeNzbInService` — upload a new NZB (on user upload)
 * - `deleteNzbFromService` — remove an orphan NZB (on review expiry cleanup)
 *
 * Both are best-effort: they log warnings on failure but never throw.
 * The authoritative source of truth is the `NzbFile` Prisma row; physical
 * files are side-effects.
 */

const NZB_API_URL = process.env.NZB_API_URL || "http://localhost:4100";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Store NZB content on the NZB service. Idempotent: if the file already
 * exists (HEAD returns 200), we skip the upload.
 *
 * @returns true on success or if the file already existed, false on failure.
 */
export async function storeNzbInService(hash: string, nzbContent: string): Promise<boolean> {
  const serviceToken = process.env.SERVICE_API_TOKEN;

  if (!serviceToken) {
    console.warn(`[nzb-service] SERVICE_API_TOKEN not set — skipping NZB storage`);
    return false;
  }

  try {
    // Check if file already exists (HEAD request)
    const headRes = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (headRes.ok) {
      console.log(`[nzb-service] NZB ${hash.slice(0, 12)}... already exists — skipping upload`);
      return true;
    }

    // Upload the NZB content
    const putRes = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/x-nzb",
      },
      body: nzbContent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (putRes.ok) {
      const data = await putRes.json().catch(() => ({})) as { size?: number };
      console.log(`[nzb-service] Stored NZB ${hash.slice(0, 12)}... (${data.size ?? "?"} bytes)`);
      return true;
    }

    const errorText = await putRes.text().catch(() => "");
    console.error(`[nzb-service] PUT failed: HTTP ${putRes.status} — ${errorText}`);
    return false;
  } catch (err: any) {
    console.error(`[nzb-service] PUT unreachable: ${err.message}`);
    return false;
  }
}

/**
 * Delete an NZB from the service. Called by the reconciler cleanup pass after
 * it has decided that a needs_review NzbFile is truly orphaned (no active
 * jobs, no movie assignment, not on S3).
 *
 * Returns true if the file was deleted OR already gone (404), false on
 * transient failures. A 404 is treated as success so repeated cleanup runs
 * are idempotent.
 */
export async function deleteNzbFromService(hash: string): Promise<boolean> {
  const serviceToken = process.env.SERVICE_API_TOKEN;

  if (!serviceToken) {
    console.warn(`[nzb-service] SERVICE_API_TOKEN not set — skipping NZB deletion`);
    return false;
  }

  try {
    const res = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok || res.status === 404) {
      console.log(
        `[nzb-service] Deleted NZB ${hash.slice(0, 12)}... (${res.status === 404 ? "already gone" : "ok"})`
      );
      return true;
    }

    const errorText = await res.text().catch(() => "");
    console.error(`[nzb-service] DELETE failed: HTTP ${res.status} — ${errorText}`);
    return false;
  } catch (err: any) {
    console.error(`[nzb-service] DELETE unreachable: ${err.message}`);
    return false;
  }
}
