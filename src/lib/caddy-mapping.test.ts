import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process.exec to avoid actual docker commands
vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, _opts: any, cb: Function) => cb(null, "", "")),
}));

describe("caddy-mapping", () => {
  let tempDir: string;
  let mapFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "caddy-test-"));
    mapFile = join(tempDir, "dl-backends.map");
    process.env.DL_MAPPING_FILE = mapFile;
    // Write empty file
    writeFileSync(mapFile, "# empty\n");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.DL_MAPPING_FILE;
    vi.resetModules();
  });

  it("adds a mapping and writes to file", async () => {
    const { addMapping, listMappings } = await import("./caddy-mapping.js");

    await addMapping("dl-test1234", "10.0.0.3");

    const mappings = listMappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toEqual({ subdomain: "dl-test1234", backend: "10.0.0.3:8080" });

    // Verify file content
    const content = readFileSync(mapFile, "utf-8");
    expect(content).toContain("dl-test1234 10.0.0.3:8080");
  });

  it("removes a mapping", async () => {
    const { addMapping, removeMapping, listMappings } = await import("./caddy-mapping.js");

    await addMapping("dl-aaaa", "10.0.0.3");
    await addMapping("dl-bbbb", "10.0.0.4");
    expect(listMappings()).toHaveLength(2);

    await removeMapping("dl-aaaa");
    const remaining = listMappings();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].subdomain).toBe("dl-bbbb");
  });

  it("is idempotent on add", async () => {
    const { addMapping, listMappings } = await import("./caddy-mapping.js");

    await addMapping("dl-test", "10.0.0.3");
    await addMapping("dl-test", "10.0.0.5"); // same name, different IP

    const mappings = listMappings();
    expect(mappings).toHaveLength(1);
    expect(mappings[0].backend).toBe("10.0.0.5:8080");
  });

  it("cleans up stale mappings", async () => {
    const { addMapping, cleanupStaleMappings, listMappings } = await import("./caddy-mapping.js");

    await addMapping("dl-active", "10.0.0.3");
    await addMapping("dl-stale1", "10.0.0.4");
    await addMapping("dl-stale2", "10.0.0.5");

    const removed = await cleanupStaleMappings(new Set(["dl-active"]));
    expect(removed).toEqual(["dl-stale1", "dl-stale2"]);
    expect(listMappings()).toHaveLength(1);
  });

  it("handles missing file gracefully", async () => {
    rmSync(mapFile, { force: true });
    const { listMappings } = await import("./caddy-mapping.js");
    expect(listMappings()).toEqual([]);
  });
});
