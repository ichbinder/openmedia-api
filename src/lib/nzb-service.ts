/**
 * Thin client for the openmedia-nzb service (nginx + Node.js running on LXC).
 *
 * The NZB service holds the physical {hash}.nzb files that the download VPS
 * fetches during provisioning. Two operations are currently needed:
 *
 * - `storeNzbInService` — upload a new NZB (on user upload). Synchronous and
 *   throwing: fails fast so callers can abort the request and surface an
 *   actionable 503 to the user instead of leaving orphan rows behind.
 * - `deleteNzbFromService` — remove an orphan NZB (on review expiry cleanup).
 *   Stays best-effort: cleanup-pass tolerates transient failures.
 */

import { recordIncident, resolveIncident } from "./incidents.js";

const NZB_API_URL = process.env.NZB_API_URL || "http://localhost:4100";
const REQUEST_TIMEOUT_MS = 5_000;
const SERVICE_NAME = "nzb-service";
const STORE_OPERATION = "store";

/**
 * Thrown by `storeNzbInService` when the NZB service is unreachable, returns
 * a non-2xx status, or auth is misconfigured. Routes catch this and respond
 * with HTTP 503 so the caller knows the request failed before any DB rows
 * were written.
 */
export class NzbServiceUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "NzbServiceUnavailableError";
    this.cause = options?.cause;
  }
}

/**
 * Store NZB content on the NZB service. Idempotent: if the file already
 * exists (HEAD returns 200), upload is skipped.
 *
 * Throws `NzbServiceUnavailableError` when the service is unreachable or
 * returns a non-2xx status. Records an open ServiceIncident on failure and
 * resolves it on the next success.
 */
export async function storeNzbInService(
  hash: string,
  nzbContent: string,
): Promise<void> {
  const serviceToken = process.env.SERVICE_API_TOKEN;

  if (!serviceToken) {
    const msg = "SERVICE_API_TOKEN not set";
    console.error(`[nzb-service] ${msg}`);
    await recordIncident(SERVICE_NAME, STORE_OPERATION, msg);
    throw new NzbServiceUnavailableError(msg);
  }

  try {
    // Check if file already exists (HEAD request)
    const headRes = await fetch(`${NZB_API_URL}/files/${hash}`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${serviceToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (headRes.ok) {
      console.log(
        `[nzb-service] NZB ${hash.slice(0, 12)}... already exists — skipping upload`,
      );
      await resolveIncident(SERVICE_NAME, STORE_OPERATION);
      return;
    }

    // 404 → upload below; any other non-ok status → treat as service problem
    if (headRes.status !== 404) {
      const errorText = await headRes.text().catch(() => "");
      const msg = `HEAD failed: HTTP ${headRes.status}${errorText ? ` — ${errorText}` : ""}`;
      console.error(`[nzb-service] ${msg}`);
      await recordIncident(SERVICE_NAME, STORE_OPERATION, msg);
      throw new NzbServiceUnavailableError(msg);
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

    if (!putRes.ok) {
      const errorText = await putRes.text().catch(() => "");
      const msg = `PUT failed: HTTP ${putRes.status}${errorText ? ` — ${errorText}` : ""}`;
      console.error(`[nzb-service] ${msg}`);
      await recordIncident(SERVICE_NAME, STORE_OPERATION, msg);
      throw new NzbServiceUnavailableError(msg);
    }

    const data = (await putRes.json().catch(() => ({}))) as { size?: number };
    console.log(
      `[nzb-service] Stored NZB ${hash.slice(0, 12)}... (${data.size ?? "?"} bytes)`,
    );
    await resolveIncident(SERVICE_NAME, STORE_OPERATION);
  } catch (err) {
    if (err instanceof NzbServiceUnavailableError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[nzb-service] unreachable: ${msg}`);
    await recordIncident(SERVICE_NAME, STORE_OPERATION, msg);
    throw new NzbServiceUnavailableError(msg, { cause: err });
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
        `[nzb-service] Deleted NZB ${hash.slice(0, 12)}... (${res.status === 404 ? "already gone" : "ok"})`,
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
