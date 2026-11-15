import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const getEntry = vi.fn();
vi.mock("./config-service.js", () => ({ getEntry: (...a: unknown[]) => getEntry(...a) }));

const KEY = "mdb-secret-key";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const movie = (detail: string | null) => ({
  title: "Dune",
  year: 2021,
  score: 78.4,
  releases: { digital: { date: "2021-10-22", detail } },
  ratings: [
    { source: "tomatoes", value: 83, score: 83, votes: 400 },
    { source: "popcorn", value: 90, score: 90, votes: null },
    { source: "letterboxd", value: null, score: null, votes: null },
  ],
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getEntry.mockReset();
  getEntry.mockResolvedValue({ value: KEY });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("fetchMdblistTitle", () => {
  it("maps a movie with digital release, ratings, score and year", async () => {
    fetchMock.mockResolvedValue(reply(200, movie("Netflix")));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    const res = await fetchMdblistTitle("movie", 438631);

    expect(res).toEqual({
      status: "found",
      label: "NETFLIX",
      brand: "netflix",
      ratings: { tomatoes: { value: 83, votes: 400 }, popcorn: { value: 90, votes: null } },
      score: 78,
      year: 2021,
    });
  });

  it("requests the movie URL with releases and the key as apikey", async () => {
    fetchMock.mockResolvedValue(reply(200, movie("Netflix")));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    await fetchMdblistTitle("movie", 438631);

    expect(getEntry).toHaveBeenCalledWith("metadata", "mdblistApiKey", true);
    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://api.mdblist.com/tmdb/movie/438631/");
    expect(u.searchParams.get("apikey")).toBe(KEY);
    expect(u.searchParams.get("append_to_response")).toBe("releases");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the network for shows and omits append_to_response", async () => {
    fetchMock.mockResolvedValue(reply(200, { title: "GoT", year: 2011, network: "HBO", ratings: [], score: null }));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    const res = await fetchMdblistTitle("show", 1399);

    expect(res).toMatchObject({ status: "found", label: "HBO", brand: "hbo", score: null });
    const u = new URL(fetchMock.mock.calls[0][0]);
    expect(u.pathname).toBe("/tmdb/show/1399/");
    expect(u.searchParams.has("append_to_response")).toBe(false);
  });

  it("labels a movie without digital detail as KINO", async () => {
    fetchMock.mockResolvedValue(reply(200, movie(null)));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toMatchObject({ label: "KINO", brand: "cinema" });
  });

  it("maps 404 to not_found", async () => {
    fetchMock.mockResolvedValue(reply(404, {}));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "not_found" });
  });

  it("maps a 200 body with a not-found error to not_found", async () => {
    fetchMock.mockResolvedValue(reply(200, { error: "Movie not found" }));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "not_found" });
  });

  it("maps 429 to rate_limited", async () => {
    fetchMock.mockResolvedValue(reply(429, {}));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "error", reason: "rate_limited" });
  });

  it("maps other failures and rejected fetches to http", async () => {
    const { fetchMdblistTitle } = await import("./mdblist.js");
    fetchMock.mockResolvedValue(reply(500, {}));
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "error", reason: "http" });
    fetchMock.mockRejectedValue(new Error(`reset ${KEY}`));
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "error", reason: "http" });
  });

  it("maps an abort to timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "error", reason: "timeout" });
  });

  it("returns not_configured without fetching when no key is set", async () => {
    getEntry.mockResolvedValue(null);
    const { fetchMdblistTitle } = await import("./mdblist.js");
    expect(await fetchMdblistTitle("movie", 1)).toEqual({ status: "error", reason: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
