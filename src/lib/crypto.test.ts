import { describe, it, expect, afterEach } from "vitest";
import { encrypt, decrypt, isEncryptionConfigured } from "../lib/crypto.js";
import { randomBytes } from "node:crypto";

// Generate a test master key (64 hex chars = 32 bytes)
const TEST_MASTER_KEY = randomBytes(32).toString("hex");

describe("Crypto Module", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  afterEach(() => {
    if (originalKey) {
      process.env.ENCRYPTION_MASTER_KEY = originalKey;
    } else {
      delete process.env.ENCRYPTION_MASTER_KEY;
    }
  });

  describe("isEncryptionConfigured", () => {
    it("returns true with valid 64-char hex key", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
      expect(isEncryptionConfigured()).toBe(true);
    });

    it("returns false when key is missing", () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      expect(isEncryptionConfigured()).toBe(false);
    });

    it("returns false for invalid key format", () => {
      process.env.ENCRYPTION_MASTER_KEY = "too-short";
      expect(isEncryptionConfigured()).toBe(false);
    });
  });

  describe("encrypt / decrypt", () => {
    it("round-trips a simple string", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;

      const plaintext = "my-secret-password-123";
      const encrypted = encrypt(plaintext);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(encrypted.tag).toHaveLength(32); // 16 bytes = 32 hex chars
      expect(encrypted.ciphertext).not.toBe(plaintext);

      const decrypted = decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips an empty string", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;

      const encrypted = encrypt("");
      const decrypted = decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
      expect(decrypted).toBe("");
    });

    it("round-trips unicode text", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;

      const plaintext = "Passwort: Ünïcödé 🔐";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;

      const e1 = encrypt("same-value");
      const e2 = encrypt("same-value");

      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.iv).not.toBe(e2.iv);
    });

    it("fails to decrypt with wrong key", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
      const encrypted = encrypt("secret");

      // Change to a different key
      process.env.ENCRYPTION_MASTER_KEY = randomBytes(32).toString("hex");

      expect(() => decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag)).toThrow();
    });

    it("fails to decrypt with tampered auth tag", () => {
      process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
      const encrypted = encrypt("secret");

      // Flip every byte in the auth tag — GCM always rejects a wrong tag
      const flippedTag = encrypted.tag
        .match(/.{2}/g)!
        .map((byte) =>
          ((parseInt(byte, 16) ^ 0xff) & 0xff).toString(16).padStart(2, "0"),
        )
        .join("");
      expect(() =>
        decrypt(encrypted.ciphertext, encrypted.iv, flippedTag),
      ).toThrow();
    });

    it("throws when key is not configured", () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      expect(() => encrypt("test")).toThrow("nicht konfiguriert");
    });
  });
});
