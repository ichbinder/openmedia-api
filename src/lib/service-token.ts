import { randomBytes, createHash } from "node:crypto";
import prisma from "./prisma.js";

/** Default token TTL: 24 hours (generous for long downloads/uploads). */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Generate a service token for VPS authentication.
 * Returns plaintext (given to VPS once) and SHA-256 hash (stored in DB).
 */
export function generateServiceToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("hex");
  const hash = hashServiceToken(plaintext);
  return { plaintext, hash };
}

/** SHA-256 hash a plaintext service token. */
export function hashServiceToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Store a service token hash in the DB, linked to a job. Expires after TTL. */
export async function storeServiceToken(
  hash: string,
  jobId: string,
  jobType: "download" | "upload",
  ttlMs: number = TOKEN_TTL_MS,
) {
  const expiresAt = new Date(Date.now() + ttlMs);
  return prisma.serviceToken.create({
    data: { tokenHash: hash, jobId, jobType, expiresAt },
  });
}

/**
 * Validate a plaintext service token against DB.
 * Returns the token record if valid and not expired, null otherwise.
 */
export async function validateServiceToken(plaintext: string) {
  const hash = hashServiceToken(plaintext);
  const token = await prisma.serviceToken.findUnique({ where: { tokenHash: hash } });
  if (!token) return null;

  // Reject expired tokens
  if (token.expiresAt < new Date()) {
    console.warn(`[service-token] Expired token used for job ${token.jobId} (expired ${token.expiresAt.toISOString()})`);
    return null;
  }

  return token;
}

/** Delete all service tokens for a given jobId. */
export async function deleteServiceTokens(jobId: string) {
  const result = await prisma.serviceToken.deleteMany({ where: { jobId } });
  if (result.count > 0) {
    console.log(`[service-token] Deleted ${result.count} token(s) for job ${jobId}`);
  }
  return result;
}
