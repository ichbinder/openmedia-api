/**
 * Configuration for the manual NZB review flow.
 *
 * When an extension uploads an NZB whose title cannot be matched to a TMDB movie
 * (not_found, or transient error like rate-limit), the resulting DownloadJob is
 * marked as `needs_review` and waits for one of:
 *  - the user to manually assign a movie via POST /downloads/jobs/:id/assign-movie
 *  - the background TMDB retry to succeed
 *  - the retention window to expire, in which case the job is failed and the
 *    orphan NzbFile is cleaned up
 *
 * All values are read from environment with safe defaults so the helper can
 * also be used in tests without touching process.env.
 */

const DEFAULT_RETENTION_DAYS = 3;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;

const DEFAULT_TMDB_INITIAL_RETRY_DELAY_SECONDS = 60;

/**
 * Read REVIEW_RETENTION_DAYS from env, clamped to a sane range.
 * Returns the default (3) if the env var is missing or invalid.
 *
 * Strict parsing: only raw digit strings are accepted. "3days", "1e2",
 * "90.5", " 3 " etc. fall back to the default rather than being silently
 * parsed by Number.parseInt (which would happily return 3, 1, 90...).
 */
export function getReviewRetentionDays(): number {
  const raw = process.env.REVIEW_RETENTION_DAYS;
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RETENTION_DAYS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RETENTION_DAYS;
  }

  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, parsed));
}

/**
 * Compute the absolute deadline by which a needs_review job must be acted on.
 */
export function computeReviewExpiresAt(now: Date = new Date()): Date {
  const days = getReviewRetentionDays();
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * When a TMDB lookup fails with a transient error, the reconciler should retry
 * after this delay. Used to compute the initial `tmdbRetryAfter` timestamp.
 */
export function computeInitialTmdbRetryAfter(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_TMDB_INITIAL_RETRY_DELAY_SECONDS * 1000);
}
