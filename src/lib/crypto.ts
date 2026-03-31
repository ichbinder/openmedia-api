/**
 * AES-256-GCM encryption/decryption for sensitive configuration values.
 *
 * Master key is read from ENCRYPTION_MASTER_KEY env var.
 * Must be a 64-character hex string (32 bytes = 256 bits).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits

/** Get the master key from env, validated as 32-byte hex. */
function getMasterKey(): Buffer {
  const hex = process.env.ENCRYPTION_MASTER_KEY;
  if (!hex) {
    throw new Error("ENCRYPTION_MASTER_KEY ist nicht konfiguriert.");
  }
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error("ENCRYPTION_MASTER_KEY muss ein 64-Zeichen Hex-String sein (256 Bit).");
  }
  return Buffer.from(hex, "hex");
}

/** Check if encryption is configured. */
export function isEncryptionConfigured(): boolean {
  const hex = process.env.ENCRYPTION_MASTER_KEY;
  return !!hex && /^[a-f0-9]{64}$/i.test(hex);
}

export interface EncryptedData {
  ciphertext: string; // hex-encoded
  iv: string;         // hex-encoded
  tag: string;        // hex-encoded
}

/** Encrypt a plaintext string with AES-256-GCM. */
export function encrypt(plaintext: string): EncryptedData {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

/** Decrypt a ciphertext with AES-256-GCM. */
export function decrypt(ciphertext: string, iv: string, tag: string): string {
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));

  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
