import { createHmac, timingSafeEqual } from "crypto";

/** Default TTL for signed media URLs: 6 hours. */
export const DEFAULT_TTL_SECONDS = 6 * 3600; // 21_600

/** Maximum allowed TTL — enforced at sign time. */
export const MAX_TTL_SECONDS = 21_600; // 6 hours

/** Minimum HMAC secret length to prevent weak keys. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Sign a media URL with an HMAC-SHA256 signature.
 *
 * Produces {sig, exp, u} query parameters for stateless URL authentication.
 * - exp = current unix timestamp + ttlSeconds
 * - sig = base64url(hmac_sha256(secret, `${hash}.${exp}.${userId}`))
 *
 * @throws {Error} if secret is shorter than MIN_SECRET_LENGTH
 * @throws {Error} if ttlSeconds exceeds MAX_TTL_SECONDS
 */
export function signMediaUrl(opts: {
  hash: string;
  userId: string;
  ttlSeconds?: number;
  secret: string;
}): { sig: string; exp: number; u: string } {
  const { hash, userId, secret } = opts;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`HMAC secret must be at least ${MIN_SECRET_LENGTH} characters, got ${secret.length}`);
  }

  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`TTL must not exceed ${MAX_TTL_SECONDS} seconds (6h), got ${ttlSeconds}`);
  }

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${hash}.${exp}.${userId}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");

  return { sig, exp, u: userId };
}

/**
 * Verify a signed media URL.
 *
 * Checks that all fields are present, the signature is valid (constant-time compare),
 * and the URL has not expired. Never throws — returns {ok: false, reason} on failure.
 *
 * @param nowFn - Injectable clock for testing (defaults to Date.now)
 */
export function verifyMediaUrl(opts: {
  hash: string;
  sig: string;
  exp: number;
  u: string;
  secret: string;
  nowFn?: () => number;
}): { ok: boolean; reason?: "expired" | "tampered" | "missing" } {
  const { hash, sig, exp, u, secret } = opts;

  // Check all required fields are present and non-empty
  if (!hash || !sig || !exp || !u || !secret) {
    return { ok: false, reason: "missing" };
  }

  const now = Math.floor((opts.nowFn ?? Date.now)() / 1000);

  // Check expiration
  if (exp <= now) {
    return { ok: false, reason: "expired" };
  }

  // Recompute expected signature
  const payload = `${hash}.${exp}.${u}`;
  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64url");

  // Constant-time comparison
  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");

  if (sigBuf.length !== expectedBuf.length) {
    return { ok: false, reason: "tampered" };
  }

  if (!timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: "tampered" };
  }

  return { ok: true };
}
