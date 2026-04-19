import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "../test/setup.js";
import {
  createProvider,
  listProviders,
  getProviderById,
  updateProvider,
  deleteProvider,
  getDownloadProviders,
  getUploadProviders,
} from "./usenet-provider-service.js";

const TEST_MASTER_KEY = randomBytes(32).toString("hex");

describe("UsenetProviderService", () => {
  const originalKey = process.env.ENCRYPTION_MASTER_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_MASTER_KEY = TEST_MASTER_KEY;
  });

  afterEach(async () => {
    await prisma.usenetProvider.deleteMany();
    if (originalKey !== undefined) process.env.ENCRYPTION_MASTER_KEY = originalKey;
    else delete process.env.ENCRYPTION_MASTER_KEY;
  });

  describe("createProvider", () => {
    it("creates a provider with encrypted password", async () => {
      const provider = await createProvider({
        name: "Eweka",
        host: "news.eweka.nl",
        postHost: "post.eweka.nl",
        username: "testuser",
        password: "supersecret",
        connections: 20,
        isDownload: true,
        isUpload: true,
      });

      expect(provider.name).toBe("Eweka");
      expect(provider.host).toBe("news.eweka.nl");
      expect(provider.postHost).toBe("post.eweka.nl");
      expect(provider.username).toBe("testuser");
      expect(provider.password).toBe("••••••••"); // masked
      expect(provider.connections).toBe(20);
      expect(provider.isDownload).toBe(true);
      expect(provider.isUpload).toBe(true);
      expect(provider.ssl).toBe(true);
      expect(provider.port).toBe(563);
    });

    it("rejects if encryption not configured", async () => {
      delete process.env.ENCRYPTION_MASTER_KEY;
      await expect(
        createProvider({ name: "Test", host: "h", username: "u", password: "p" }),
      ).rejects.toThrow("Encryption not configured");
    });

    it("rejects duplicate names", async () => {
      await createProvider({ name: "Eweka", host: "h", username: "u", password: "p" });
      await expect(
        createProvider({ name: "Eweka", host: "h2", username: "u2", password: "p2" }),
      ).rejects.toThrow();
    });
  });

  describe("listProviders", () => {
    it("lists providers ordered by priority then name", async () => {
      await createProvider({ name: "Beta", host: "b", username: "u", password: "p", priority: 1 });
      await createProvider({ name: "Alpha", host: "a", username: "u", password: "p", priority: 0 });
      await createProvider({ name: "Charlie", host: "c", username: "u", password: "p", priority: 0 });

      const list = await listProviders();
      expect(list).toHaveLength(3);
      expect(list[0].name).toBe("Alpha");
      expect(list[1].name).toBe("Charlie");
      expect(list[2].name).toBe("Beta");
    });

    it("masks passwords by default", async () => {
      await createProvider({ name: "Test", host: "h", username: "u", password: "secret123" });
      const list = await listProviders();
      expect(list[0].password).toBe("••••••••");
    });

    it("reveals passwords when requested", async () => {
      await createProvider({ name: "Test", host: "h", username: "u", password: "secret123" });
      const list = await listProviders(true);
      expect(list[0].password).toBe("secret123");
    });
  });

  describe("getProviderById", () => {
    it("returns a provider by id", async () => {
      const created = await createProvider({ name: "Test", host: "h", username: "u", password: "p" });
      const found = await getProviderById(created.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Test");
    });

    it("returns null for unknown id", async () => {
      const found = await getProviderById("non-existent-id");
      expect(found).toBeNull();
    });
  });

  describe("updateProvider", () => {
    it("updates non-password fields without re-encrypting", async () => {
      const created = await createProvider({ name: "Test", host: "h", username: "u", password: "p" });
      const updated = await updateProvider(created.id, { name: "Updated", connections: 30 });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated");
      expect(updated!.connections).toBe(30);
    });

    it("re-encrypts password when changed", async () => {
      const created = await createProvider({ name: "Test", host: "h", username: "u", password: "old" });
      await updateProvider(created.id, { password: "newpass" });
      const revealed = await getProviderById(created.id, true);
      expect(revealed!.password).toBe("newpass");
    });

    it("returns null for unknown id", async () => {
      const result = await updateProvider("non-existent-id", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteProvider", () => {
    it("deletes an existing provider", async () => {
      const created = await createProvider({ name: "Test", host: "h", username: "u", password: "p" });
      const deleted = await deleteProvider(created.id);
      expect(deleted).toBe(true);
      const found = await getProviderById(created.id);
      expect(found).toBeNull();
    });

    it("returns false for unknown id", async () => {
      const deleted = await deleteProvider("non-existent-id");
      expect(deleted).toBe(false);
    });
  });

  describe("getDownloadProviders / getUploadProviders", () => {
    it("returns only enabled download providers with decrypted passwords", async () => {
      await createProvider({ name: "DL1", host: "h1", username: "u", password: "pass1", isDownload: true });
      await createProvider({ name: "UL1", host: "h2", username: "u", password: "pass2", isUpload: true });
      await createProvider({ name: "DL2", host: "h3", username: "u", password: "pass3", isDownload: true, enabled: false });

      const dl = await getDownloadProviders();
      expect(dl).toHaveLength(1);
      expect(dl[0].name).toBe("DL1");
      expect(dl[0].password).toBe("pass1"); // decrypted
    });

    it("returns only enabled upload providers with decrypted passwords", async () => {
      await createProvider({ name: "DL1", host: "h1", username: "u", password: "pass1", isDownload: true });
      await createProvider({ name: "UL1", host: "h2", username: "u", password: "pass2", isUpload: true });

      const ul = await getUploadProviders();
      expect(ul).toHaveLength(1);
      expect(ul[0].name).toBe("UL1");
      expect(ul[0].password).toBe("pass2");
    });

    it("returns empty array when no providers exist", async () => {
      const dl = await getDownloadProviders();
      const ul = await getUploadProviders();
      expect(dl).toHaveLength(0);
      expect(ul).toHaveLength(0);
    });
  });
});
