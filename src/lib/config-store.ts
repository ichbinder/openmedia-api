/**
 * Encrypted configuration store — stores key-value pairs
 * with AES-256-GCM encryption in PostgreSQL.
 *
 * Values are never stored in plaintext. Only the key names are visible.
 */

import prisma from "./prisma.js";
import { encrypt, decrypt, isEncryptionConfigured } from "./crypto.js";

/** Set a configuration value (encrypts and upserts). */
export async function setConfig(key: string, value: string): Promise<void> {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption ist nicht konfiguriert (ENCRYPTION_MASTER_KEY fehlt).");
  }

  const encrypted = encrypt(value);

  await prisma.encryptedConfig.upsert({
    where: { key },
    create: {
      key,
      encryptedValue: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
    },
    update: {
      encryptedValue: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
    },
  });

  console.log(`[config] Set: ${key}`);
}

/** Get a configuration value (decrypts). Returns null if not found. */
export async function getConfig(key: string): Promise<string | null> {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption ist nicht konfiguriert (ENCRYPTION_MASTER_KEY fehlt).");
  }

  const config = await prisma.encryptedConfig.findUnique({ where: { key } });
  if (!config) return null;

  try {
    return decrypt(config.encryptedValue, config.iv, config.tag);
  } catch (err) {
    console.error(`[config] Decryption failed for key: ${key}`);
    throw new Error(`Entschlüsselung fehlgeschlagen für Key: ${key}`);
  }
}

/** Delete a configuration value. Returns true if deleted. */
export async function deleteConfig(key: string): Promise<boolean> {
  try {
    await prisma.encryptedConfig.delete({ where: { key } });
    console.log(`[config] Deleted: ${key}`);
    return true;
  } catch (err: any) {
    if (err?.code === "P2025") return false;
    throw err;
  }
}

/** List all configuration keys (without values). */
export async function listConfigKeys(): Promise<string[]> {
  const configs = await prisma.encryptedConfig.findMany({
    select: { key: true },
    orderBy: { key: "asc" },
  });
  return configs.map((c) => c.key);
}

/** Check if a configuration key exists. */
export async function hasConfig(key: string): Promise<boolean> {
  const count = await prisma.encryptedConfig.count({ where: { key } });
  return count > 0;
}
