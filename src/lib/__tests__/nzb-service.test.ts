import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../test/setup.js";

// Hoisted spies on incidents helpers — verified independently in incidents.test.ts.
const recordIncidentSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resolveIncidentSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../incidents.js", () => ({
  recordIncident: recordIncidentSpy,
  resolveIncident: resolveIncidentSpy,
}));

import {
  storeNzbInService,
  NzbServiceUnavailableError,
} from "../nzb-service.js";

const HASH = "deadbeef".repeat(8); // 64 hex chars
const NZB = "<?xml version=\"1.0\"?><nzb></nzb>";

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "service_incidents" CASCADE');
  recordIncidentSpy.mockClear();
  resolveIncidentSpy.mockClear();
  process.env.SERVICE_API_TOKEN = "test-token";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetchSequence(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("storeNzbInService", () => {
  it("resolved und resolveIncident wenn HEAD 200 (datei existiert)", async () => {
    mockFetchSequence(new Response(null, { status: 200 }));

    await expect(storeNzbInService(HASH, NZB)).resolves.toBeUndefined();
    expect(resolveIncidentSpy).toHaveBeenCalledWith("nzb-service", "store");
    expect(recordIncidentSpy).not.toHaveBeenCalled();
  });

  it("uploaded bei HEAD 404 + PUT 200 und resolved den Incident", async () => {
    const fetchMock = mockFetchSequence(
      new Response(null, { status: 404 }),
      new Response(JSON.stringify({ size: 1234 }), { status: 200 }),
    );

    await expect(storeNzbInService(HASH, NZB)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    expect(resolveIncidentSpy).toHaveBeenCalledWith("nzb-service", "store");
    expect(recordIncidentSpy).not.toHaveBeenCalled();
  });

  it("wirft NzbServiceUnavailableError wenn fetch netzwerktechnisch failed", async () => {
    mockFetchSequence(new Error("ECONNREFUSED"));

    await expect(storeNzbInService(HASH, NZB)).rejects.toBeInstanceOf(
      NzbServiceUnavailableError,
    );
    expect(recordIncidentSpy).toHaveBeenCalledWith(
      "nzb-service",
      "store",
      expect.stringContaining("ECONNREFUSED"),
    );
    expect(resolveIncidentSpy).not.toHaveBeenCalled();
  });

  it("wirft NzbServiceUnavailableError wenn PUT mit 5xx antwortet", async () => {
    mockFetchSequence(
      new Response(null, { status: 404 }),
      new Response("upstream down", { status: 502 }),
    );

    await expect(storeNzbInService(HASH, NZB)).rejects.toBeInstanceOf(
      NzbServiceUnavailableError,
    );
    expect(recordIncidentSpy).toHaveBeenCalledWith(
      "nzb-service",
      "store",
      expect.stringContaining("502"),
    );
    expect(resolveIncidentSpy).not.toHaveBeenCalled();
  });

  it("wirft NzbServiceUnavailableError wenn HEAD ein unerwartetes 5xx liefert", async () => {
    mockFetchSequence(new Response("nope", { status: 500 }));

    await expect(storeNzbInService(HASH, NZB)).rejects.toBeInstanceOf(
      NzbServiceUnavailableError,
    );
    expect(recordIncidentSpy).toHaveBeenCalledWith(
      "nzb-service",
      "store",
      expect.stringContaining("500"),
    );
  });

  it("wirft NzbServiceUnavailableError wenn SERVICE_API_TOKEN fehlt", async () => {
    delete process.env.SERVICE_API_TOKEN;

    await expect(storeNzbInService(HASH, NZB)).rejects.toBeInstanceOf(
      NzbServiceUnavailableError,
    );
    expect(recordIncidentSpy).toHaveBeenCalledWith(
      "nzb-service",
      "store",
      expect.stringContaining("SERVICE_API_TOKEN"),
    );
  });
});
