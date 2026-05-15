import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPluginSourceZip,
  _resetPluginSourceCache,
  _setGithubFetcher,
} from "../jellyfin-plugin-source.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Erzeugt einen minimal gueltigen ZIP-Puffer (4 Bytes PK-Signatur). */
function makeFakeZip(): Buffer {
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("jellyfin-plugin-source", () => {
  beforeEach(() => {
    _resetPluginSourceCache();
    _setGithubFetcher(null);
    vi.restoreAllMocks();
  });

  it("success: fetches ZIP buffer and version", async () => {
    const fakeZip = makeFakeZip();
    _setGithubFetcher(async () => ({
      buffer: fakeZip,
      version: "1.1.0",
    }));

    const result = await getPluginSourceZip();
    expect(result.buffer).toEqual(fakeZip);
    expect(result.version).toBe("1.1.0");
  });

  it("cache-hit: second call returns cached data without re-fetching", async () => {
    let callCount = 0;
    const fakeZip = makeFakeZip();
    _setGithubFetcher(async () => {
      callCount++;
      return { buffer: fakeZip, version: "1.1.0" };
    });

    const first = await getPluginSourceZip();
    const second = await getPluginSourceZip();
    expect(first.buffer).toEqual(second.buffer);
    expect(first.version).toBe(second.version);
    expect(callCount).toBe(1); // fetcher called only once
  });

  it("TTL-expire: re-fetches after success TTL expires", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const fakeZip = makeFakeZip();
      _setGithubFetcher(async () => {
        callCount++;
        return { buffer: fakeZip, version: "1.1.0" };
      });

      await getPluginSourceZip();
      expect(callCount).toBe(1);

      // Advance past TTL (1 hour + 1ms)
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      await getPluginSourceZip();
      expect(callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("error-cache: caches errors with shorter TTL", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      _setGithubFetcher(async () => {
        callCount++;
        throw new Error("upstream unavailable");
      });

      await expect(getPluginSourceZip()).rejects.toThrow("upstream unavailable");
      expect(callCount).toBe(1);

      // Within error TTL (5 min) — should throw cached error without re-fetching
      vi.advanceTimersByTime(60_000); // 1 min
      await expect(getPluginSourceZip()).rejects.toThrow("cached upstream error");
      expect(callCount).toBe(1); // still only 1 fetch call

      // After error TTL expires (5 min + 1ms) — should re-fetch
      vi.advanceTimersByTime(4 * 60 * 1000 + 1); // total > 5 min
      await expect(getPluginSourceZip()).rejects.toThrow("upstream unavailable");
      expect(callCount).toBe(2); // re-fetched
    } finally {
      vi.useRealTimers();
    }
  });

  it("version-override: pinned version is passed to fetcher", async () => {
    const originalEnv = process.env.JELLYFIN_PLUGIN_VERSION;
    process.env.JELLYFIN_PLUGIN_VERSION = "2.0.0";

    try {
      let capturedVersion: string | null = "unset";
      const fakeZip = makeFakeZip();
      _setGithubFetcher(async (_repo, version) => {
        capturedVersion = version;
        return { buffer: fakeZip, version: "2.0.0" };
      });

      const result = await getPluginSourceZip();
      expect(result.version).toBe("2.0.0");
      expect(capturedVersion).toBe("2.0.0");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.JELLYFIN_PLUGIN_VERSION;
      } else {
        process.env.JELLYFIN_PLUGIN_VERSION = originalEnv;
      }
    }
  });

  it("anon-fetch: works without GITHUB_API_TOKEN", async () => {
    const originalToken = process.env.GITHUB_API_TOKEN;
    delete process.env.GITHUB_API_TOKEN;

    try {
      const fakeZip = makeFakeZip();
      let usedToken = true;
      _setGithubFetcher(async () => {
        // Simulate no auth header present — this is the default
        usedToken = !!process.env.GITHUB_API_TOKEN;
        return { buffer: fakeZip, version: "1.1.0" };
      });

      const result = await getPluginSourceZip();
      expect(result.buffer).toEqual(fakeZip);
      expect(usedToken).toBe(false);
    } finally {
      if (originalToken !== undefined) {
        process.env.GITHUB_API_TOKEN = originalToken;
      }
    }
  });
});
