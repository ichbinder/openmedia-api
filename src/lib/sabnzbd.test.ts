import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendToSabnzbd, getSabnzbdStatus, isSabnzbdConfigured } from "./sabnzbd.js";

// Save original env
const originalEnv = { ...process.env };

describe("SABnzbd Client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset env
    process.env = { ...originalEnv };
  });

  describe("isSabnzbdConfigured", () => {
    it("gibt false wenn URL fehlt", () => {
      delete process.env.SABNZBD_URL;
      delete process.env.SABNZBD_API_KEY;
      // Module caches the values at import time, so we test the function's logic
      expect(isSabnzbdConfigured()).toBe(false);
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
