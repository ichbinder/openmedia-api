import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/treasure-maps-severance-s02e05.json";
import { clearCache } from "./ttl-cache.js";

const getEntry = vi.fn();
vi.mock("./config-service.js", () => ({ getEntry: (...a: unknown[]) => getEntry(...a) }));

const KEY = "secret-api-key-123";
const GUID = "41167b5c8fbfef7ffea529a9093284b6";
const NZB = '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"></nzb>';

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(typeof body === "object" && body && "location" in body ? { location: String((body as { location: string }).location) } : {}),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearCache();
  getEntry.mockReset();
  getEntry.mockResolvedValue({ value: KEY });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("treasure-maps client", () => {
  it("searchEpisode sends key and query and maps releases", async () => {
    fetchMock.mockResolvedValue(reply(200, fixture));
    const { searchEpisode } = await import("./treasure-maps.js");
    const releases = await searchEpisode(95396, 2, 5);

    expect(getEntry).toHaveBeenCalledWith("indexer", "treasureMapsApiKey", true);
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://treasure-maps.com/api/v1/tv");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      tmdbid: "95396", season: "2", ep: "5", cat: "5100", extended: "true", limit: "100",
    });
    expect(init.headers["X-API-Key"]).toBe(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(releases).toHaveLength(20);
    expect(releases[0]).toMatchObject({
      guid: GUID, videoWidth: 1918, audioLanguages: ["English", "German"], season: 2, episode: 5,
    });
    const idx = fixture.items.findIndex((i) => !i.video);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(releases[idx].videoWidth).toBeNull();
    expect(releases[idx].audioLanguages).toBeNull();
  });

  it("maps a release without video to null width and null languages", async () => {
    const bare = { ...fixture.items[0], video: null, audio_languages: null, subtitles: null };
    fetchMock.mockResolvedValue(reply(200, { items: [bare], pagination: {} }));
    const { searchEpisode } = await import("./treasure-maps.js");
    const [r] = await searchEpisode(1, 1, 1);
    expect(r.videoWidth).toBeNull();
    expect(r.audioLanguages).toBeNull();
    expect(r.subtitles).toBeNull();
  });

  it("caches the second identical search", async () => {
    fetchMock.mockResolvedValue(reply(200, fixture));
    const { searchEpisode } = await import("./treasure-maps.js");
    await searchEpisode(95396, 2, 5);
    await searchEpisode(95396, 2, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws not_configured without fetching", async () => {
    getEntry.mockResolvedValue(null);
    const { searchEpisode, IndexerError } = await import("./treasure-maps.js");
    const err = await searchEpisode(1, 1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.reason).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 429 to rate_limited without leaking the key", async () => {
    fetchMock.mockResolvedValue(reply(429, { error: { status: 429, code: "rate_limited", message: "slow down", retry_after: 3 } }));
    const { searchEpisode } = await import("./treasure-maps.js");
    const err = await searchEpisode(1, 1, 1).catch((e) => e);
    expect(err.reason).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.message).not.toContain(KEY);
  });

  it("maps other failures to http with status", async () => {
    fetchMock.mockResolvedValue(reply(500, {}));
    const { searchEpisode } = await import("./treasure-maps.js");
    const err = await searchEpisode(1, 1, 1).catch((e) => e);
    expect(err.reason).toBe("http");
    expect(err.status).toBe(500);
  });

  it("spaces consecutive requests at least 250 ms apart", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    fetchMock.mockImplementation(async () => {
      times.push(Date.now());
      return reply(200, { limits: { download_current: 3, download_max: 100 } });
    });
    const { getDownloadBudget } = await import("./treasure-maps.js");
    const a = getDownloadBudget();
    const b = getDownloadBudget();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await a).toEqual({ used: 3, max: 100 });
    await b;
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(250);
  });

  it("downloadNzb returns the NZB body", async () => {
    fetchMock.mockResolvedValue(reply(200, NZB));
    const { downloadNzb } = await import("./treasure-maps.js");
    expect(await downloadNzb(GUID)).toBe(NZB);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://treasure-maps.com/api/v1/releases/${GUID}/download`);
  });

  it.each([["a short body", "<nzb/>"], ["a body without <nzb", `<html>${"x".repeat(100)}</html>`]])(
    "downloadNzb rejects %s as IndexerError http",
    async (_label, body) => {
      fetchMock.mockResolvedValue(reply(200, body));
      const { downloadNzb, IndexerError } = await import("./treasure-maps.js");
      const err = await downloadNzb(GUID).catch((e) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect(err.reason).toBe("http");
    },
  );

  it("maps a failing key decryption to not_configured without the original message", async () => {
    getEntry.mockRejectedValue(new Error(`bad decrypt ${KEY}`));
    const { searchEpisode, IndexerError } = await import("./treasure-maps.js");
    const err = await searchEpisode(3, 3, 3).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.reason).toBe("not_configured");
    expect(err.message).not.toContain("decrypt");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloadNzb rejects an invalid guid without fetching", async () => {
    const { downloadNzb } = await import("./treasure-maps.js");
    const err = await downloadNzb("../x").catch((e) => e);
    expect(err.reason).toBe("http");
    expect(err.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send the key to a cross-origin redirect target", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(302, { location: "https://cdn.example.org/n.nzb" }))
      .mockResolvedValueOnce(reply(200, NZB));
    const { downloadNzb } = await import("./treasure-maps.js");
    expect(await downloadNzb(GUID)).toBe(NZB);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://cdn.example.org/n.nzb");
    expect(init.headers["X-API-Key"]).toBeUndefined();
  });

  it("keeps the key on a same-origin redirect", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(302, { location: "/api/v1/files/n.nzb" }))
      .mockResolvedValueOnce(reply(200, NZB));
    const { downloadNzb } = await import("./treasure-maps.js");
    await downloadNzb(GUID);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("https://treasure-maps.com/api/v1/files/n.nzb");
    expect(init.headers["X-API-Key"]).toBe(KEY);
  });

  it("maps a rejected fetch to IndexerError http without the key", async () => {
    fetchMock.mockRejectedValue(new Error(`reset ${KEY}`));
    const { searchEpisode, IndexerError } = await import("./treasure-maps.js");
    const err = await searchEpisode(1, 1, 1).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.reason).toBe("http");
    expect(err.message).not.toContain(KEY);
  });

  it("maps a budget body without limits to IndexerError http", async () => {
    fetchMock.mockResolvedValue(reply(200, { user: {} }));
    const { getDownloadBudget, IndexerError } = await import("./treasure-maps.js");
    await expect(getDownloadBudget()).rejects.toBeInstanceOf(IndexerError);
  });

  it("maps a search body without items array to IndexerError http", async () => {
    fetchMock.mockResolvedValue(reply(200, { items: "nope" }));
    const { searchEpisode, IndexerError } = await import("./treasure-maps.js");
    await expect(searchEpisode(2, 2, 2)).rejects.toBeInstanceOf(IndexerError);
  });
});
