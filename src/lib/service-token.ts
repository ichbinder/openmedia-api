import { randomBytes, createHash } from "node:crypto";
import prisma from "./prisma.js";

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

/** Store a service token hash in the DB, linked to a job. */
export async function storeServiceToken(
  hash: string,
  jobId: string,
  jobType: "download" | "upload",
) {
  return prisma.serviceToken.create({
    data: { tokenHash: hash, jobId, jobType },
  });
}

/**
 * Validate a plaintext service token against DB.
 * Returns the token record if valid, null otherwise.
 */
export async function validateServiceToken(plaintext: string) {
  const hash = hashServiceToken(plaintext);
  return prisma.serviceToken.findUnique({ where: { tokenHash: hash } });
}

/** Delete all service tokens for a given jobId. */
export async function deleteServiceTokens(jobId: string) {
  const result = await prisma.serviceToken.deleteMany({ where: { jobId } });
  if (result.count > 0) {
    console.log(`[service-token] Deleted ${result.count} token(s) for job ${jobId}`);
  }
  return result;
}
