import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendToSabnzbd, getSabnzbdStatus, isSabnzbdConfigured, getSabnzbdConfigSummary } from "./sabnzbd.js";

describe("SABnzbd Client", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Ensure SABnzbd is NOT configured for these tests
    delete process.env.SABNZBD_URL;
    delete process.env.SABNZBD_API_KEY;
    delete process.env.SABNZBD_CATEGORY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe("isSabnzbdConfigured", () => {
    it("gibt false wenn URL und API Key fehlen", () => {
      expect(isSabnzbdConfigured()).toBe(false);
    });

    it("gibt true wenn URL und API Key gesetzt", () => {
      process.env.SABNZBD_URL = "http://test:8080";
      process.env.SABNZBD_API_KEY = "test-key";
      expect(isSabnzbdConfigured()).toBe(true);
    });
  });

  describe("getSabnzbdConfigSummary", () => {
    it("zeigt configured: false wenn nicht konfiguriert", () => {
      const config = getSabnzbdConfigSummary();
      expect(config.configured).toBe(false);
      // Should NOT expose URL or API key
      expect(config).not.toHaveProperty("url");
      expect(config).not.toHaveProperty("apiKey");
    });

    it("zeigt category wenn gesetzt", () => {
      process.env.SABNZBD_URL = "http://test:8080";
      process.env.SABNZBD_API_KEY = "test-key";
      process.env.SABNZBD_CATEGORY = "movies";
      const config = getSabnzbdConfigSummary();
      expect(config.configured).toBe(true);
      expect(config.category).toBe("movies");
    });
  });

  describe("sendToSabnzbd", () => {
    it("gibt Fehler wenn nicht konfiguriert", async () => {
      const result = await sendToSabnzbd("<nzb>test</nzb>", "test.nzb");
      expect(result.success).toBe(false);
      expect(result.error).toContain("nicht konfiguriert");
    });
  });

  describe("getSabnzbdStatus", () => {
    it("gibt disconnected wenn nicht konfiguriert", async () => {
      const result = await getSabnzbdStatus();
      expect(result.connected).toBe(false);
      expect(result.error).toContain("nicht konfiguriert");
    });
  });
});
