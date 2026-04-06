import { createHash, randomBytes } from "crypto";

/** Prefix for all OpenMedia API tokens — makes them identifiable in logs and leak scanners. */
export const TOKEN_PREFIX = "om_";

/**
 * Generate a cryptographically secure API token.
 * Format: om_ + 48 random bytes as base64url ≈ 67 characters total.
 * Returns the plaintext token (shown to user once) and its SHA-256 hash (stored in DB).
 */
export function generateApiToken(): { plaintext: string; hash: string; prefix: string } {
  const raw = randomBytes(48).toString("base64url");
  const plaintext = `${TOKEN_PREFIX}${raw}`;
  const hash = hashToken(plaintext);
  const prefix = plaintext.slice(0, 11); // "om_" + 8 chars
  return { plaintext, hash, prefix };
}

/**
 * Compute SHA-256 hash of a plaintext token.
 * Used both at creation (to store) and at auth (to look up).
 */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Check whether a string looks like an OpenMedia API token.
 */
export function isApiToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > 20;
}

/** Allowed expiration durations in days. */
export const ALLOWED_EXPIRY_DAYS = [30, 60, 90] as const;
export type ExpiryDays = (typeof ALLOWED_EXPIRY_DAYS)[number];
