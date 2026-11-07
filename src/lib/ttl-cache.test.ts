import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cached, clearCache } from "./ttl-cache.js";

describe("cached", () => {
  beforeEach(() => {
    clearCache();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reuses the value within the TTL and reloads after it", async () => {
    const load = vi.fn(async () => "v");
    await cached("k", 1000, load);
    await cached("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    await cached("k", 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache rejections", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("ok");
    await expect(cached("k", 1000, load)).rejects.toThrow("x");
    expect(await cached("k", 1000, load)).toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache values rejected by keep", async () => {
    const load = vi.fn(async () => "bad");
    await cached("k", 1000, load, () => false);
    await cached("k", 1000, load, () => false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight promise between concurrent calls", async () => {
    const load = vi.fn(async () => "v");
    await Promise.all([cached("k", 1000, load), cached("k", 1000, load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
