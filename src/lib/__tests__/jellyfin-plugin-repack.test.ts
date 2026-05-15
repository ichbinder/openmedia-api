import { describe, it, expect } from "vitest";
import {
  repackPluginWithBootstrap,
} from "../jellyfin-plugin-repack.js";
import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Erzeugt ein minimales Plugin-ZIP mit meta.json und einer Dummy-DLL. */
async function makeSourceZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("meta.json", JSON.stringify({ version: "1.1.0", name: "OpenMedia" }));
  zip.file("Jellyfin.Plugin.OpenMedia.dll", Buffer.from("fake-dll-content"));
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("jellyfin-plugin-repack", () => {
  it("repack-roundtrip: bootstrap.json content is correct", async () => {
    const sourceZip = await makeSourceZip();
    const { buffer } = await repackPluginWithBootstrap(sourceZip, {
      apiUrl: "https://api.example.com",
      apiToken: "tok-123",
    });

    const repacked = await JSZip.loadAsync(buffer);
    const bootstrapText = await repacked.file("bootstrap.json")?.async("string");
    expect(bootstrapText).toBeDefined();

    const bootstrap = JSON.parse(bootstrapText!);
    expect(bootstrap.apiUrl).toBe("https://api.example.com");
    expect(bootstrap.apiToken).toBe("tok-123");
  });

  it("md5-deterministic: same inputs produce same MD5", async () => {
    const sourceZip = await makeSourceZip();
    const opts = { apiUrl: "https://api.example.com", apiToken: "tok-abc" };

    const result1 = await repackPluginWithBootstrap(sourceZip, opts);
    const result2 = await repackPluginWithBootstrap(sourceZip, opts);

    expect(result1.md5).toBe(result2.md5);
    expect(result1.buffer).toEqual(result2.buffer);
  });

  it("md5-different: different tokens produce different MD5", async () => {
    const sourceZip = await makeSourceZip();

    const result1 = await repackPluginWithBootstrap(sourceZip, {
      apiUrl: "https://api.example.com",
      apiToken: "tok-aaa",
    });
    const result2 = await repackPluginWithBootstrap(sourceZip, {
      apiUrl: "https://api.example.com",
      apiToken: "tok-bbb",
    });

    expect(result1.md5).not.toBe(result2.md5);
  });

  it("size-field: returned size matches buffer length", async () => {
    const sourceZip = await makeSourceZip();
    const { buffer, size } = await repackPluginWithBootstrap(sourceZip, {
      apiUrl: "https://api.example.com",
      apiToken: "tok-xyz",
    });

    expect(size).toBe(buffer.length);
    expect(size).toBeGreaterThan(0);
  });

  it("original-files-preserved: repacked ZIP still contains original entries", async () => {
    const sourceZip = await makeSourceZip();
    const { buffer } = await repackPluginWithBootstrap(sourceZip, {
      apiUrl: "https://api.example.com",
      apiToken: "tok-123",
    });

    const repacked = await JSZip.loadAsync(buffer);
    expect(repacked.file("meta.json")).not.toBeNull();
    expect(repacked.file("Jellyfin.Plugin.OpenMedia.dll")).not.toBeNull();
    expect(repacked.file("bootstrap.json")).not.toBeNull();
  });
});
