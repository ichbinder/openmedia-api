import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isHetznerConfigured,
  generateCloudInit,
  generateUploadCloudInit,
  createServer,
} from "../lib/hetzner.js";

describe("Hetzner Service", () => {
  describe("isHetznerConfigured", () => {
    const originalToken = process.env.HETZNER_API_TOKEN;

    afterEach(() => {
      if (originalToken) {
        process.env.HETZNER_API_TOKEN = originalToken;
      } else {
        delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("returns true when token is set", () => {
      process.env.HETZNER_API_TOKEN = "test-token";
      expect(isHetznerConfigured()).toBe(true);
    });

    it("returns false when token is missing", () => {
      delete process.env.HETZNER_API_TOKEN;
      expect(isHetznerConfigured()).toBe(false);
    });

    it("returns false when token is empty", () => {
      process.env.HETZNER_API_TOKEN = "";
      expect(isHetznerConfigured()).toBe(false);
    });
  });

  describe("generateCloudInit", () => {
    const defaultParams = {
      jobId: "test-job-123",
      apiBaseUrl: "http://api.example.com",
      serviceToken: "test-service-token-hex",
      dockerImage: "ghcr.io/ichbinder/openmedia-downloader:latest",
      serverName: "dl-test1234",
    };

    /** Extract and decode the base64-encoded env file from cloud-init */
    function decodeEnvFromCloudInit(cloudInit: string): string {
      const match = cloudInit.match(/content:\s*([A-Za-z0-9+/=]+)/);
      if (!match) return "";
      return Buffer.from(match[1], "base64").toString("utf-8");
    }

    it("generates valid cloud-init YAML with docker run", () => {
      const cloudInit = generateCloudInit(defaultParams);

      expect(cloudInit).toContain("#cloud-config");
      expect(cloudInit).toContain("test-job-123");
      expect(cloudInit).toContain("api.example.com");
      expect(cloudInit).toContain("docker pull");
      expect(cloudInit).toContain("docker run");
      expect(cloudInit).toContain("openmedia-downloader");
      expect(cloudInit).toContain("fail_job");
      expect(cloudInit).toContain("--env-file");
    });

    it("docker pull is wrapped in a retry loop (5 attempts)", () => {
      const cloudInit = generateCloudInit(defaultParams);

      expect(cloudInit).toContain("PULL_OK=0");
      expect(cloudInit).toContain("for attempt in 1 2 3 4 5");
      expect(cloudInit).toContain("RETRY_DELAY=$((attempt * 10))");
      expect(cloudInit).toContain('Docker pull failed after 5 attempts');
      // Sleep nur vor weiteren Versuchen — kein unnoetiges Warten nach dem letzten Fehlschlag
      expect(cloudInit).toContain('[ "$attempt" -lt 5 ]');
    });

    it("upload cloud-init: docker pull ist ebenfalls in Retry-Loop (5 Versuche) gekapselt", () => {
      const cloudInit = generateUploadCloudInit({
        jobId: "test-job-123",
        apiBaseUrl: "http://api.example.com",
        serviceToken: "test-service-token-hex",
        dockerImage: "ghcr.io/ichbinder/openmedia-uploader:latest",
        serverName: "ul-test1234",
      });

      expect(cloudInit).toContain("PULL_OK=0");
      expect(cloudInit).toContain("for attempt in 1 2 3 4 5");
      expect(cloudInit).toContain("RETRY_DELAY=$((attempt * 10))");
      expect(cloudInit).toContain("Docker pull failed after 5 attempts");
      expect(cloudInit).toContain('[ "$attempt" -lt 5 ]');
    });

    it("env file contains only JOB_ID, API_BASE_URL, SERVICE_TOKEN", () => {
      const cloudInit = generateCloudInit(defaultParams);
      const envContent = decodeEnvFromCloudInit(cloudInit);

      expect(envContent).toContain("JOB_ID=test-job-123");
      expect(envContent).toContain("API_BASE_URL=http://api.example.com");
      expect(envContent).toContain("SERVICE_TOKEN=test-service-token-hex");

      // Must NOT contain legacy vars — VPS fetches these at boot
      expect(envContent).not.toContain("S3_ACCESS_KEY");
      expect(envContent).not.toContain("USENET_SERVERS");
      expect(envContent).not.toContain("NZB_URL");
      expect(envContent).not.toContain("JOB_HASH");
    });

    it("uses service token in fail_job and cleanup curl calls", () => {
      const cloudInit = generateCloudInit(defaultParams);
      expect(cloudInit).toContain("test-service-token-hex");
    });

    it("location fallback: tries each location until one succeeds", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn();
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      // First two locations return 412 placement_error, third succeeds.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "resource_unavailable_in_location", message: "no capacity" } }),
      } as any);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "placement_error", message: "no capacity" } }),
      } as any);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          server: { id: 42, name: "x", status: "initializing", server_type: { name: "cax21" }, datacenter: { location: { name: "nbg1" } }, public_net: {}, labels: {}, created: new Date().toISOString() },
          root_password: null,
        }),
      } as any);

      try {
        const result = await createServer({
          name: "test",
          locations: ["hel1", "fsn1", "nbg1"],
        });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(result.server.id).toBe(42);
        // Verify each call sent the right location.
        const bodies = fetchMock.mock.calls.map(([, init]: any) => JSON.parse(init.body));
        expect(bodies[0].location).toBe("hel1");
        expect(bodies[1].location).toBe("fsn1");
        expect(bodies[2].location).toBe("nbg1");
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("location fallback: throws after all locations exhausted", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "placement_error", message: "no capacity" } }),
      });
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      try {
        await expect(
          createServer({ name: "test", locations: ["hel1", "fsn1"] })
        ).rejects.toThrow(/keine Server-Type\/Location-Kombination verfuegbar/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("server-type fallback: tries next type when first is unavailable", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn();
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      // First server-type fails in the (only) location, second succeeds.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "resource_unavailable_in_location", message: "no capacity" } }),
      } as any);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          server: { id: 99, name: "x", status: "initializing", server_type: { name: "cax21" }, datacenter: { location: { name: "hel1" } }, public_net: {}, labels: {}, created: new Date().toISOString() },
          root_password: null,
        }),
      } as any);

      try {
        const result = await createServer({
          name: "test",
          serverTypes: ["cax11", "cax21"],
          locations: ["hel1"],
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.server.id).toBe(99);
        const bodies = fetchMock.mock.calls.map(([, init]: any) => JSON.parse(init.body));
        expect(bodies[0].server_type).toBe("cax11");
        expect(bodies[0].location).toBe("hel1");
        expect(bodies[1].server_type).toBe("cax21");
        expect(bodies[1].location).toBe("hel1");
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("server-type x location loop: outer = location, inner = type (Helsinki-first)", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn();
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      // 3 failures exhausting hel1 (cax11, cax21) and first fsn1 attempt
      // (cax11), 4th succeeds (cax21 x fsn1). Demonstrates that ALL server
      // types are exhausted in the preferred location before falling over
      // to the next location.
      const failure = {
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "placement_error", message: "no capacity" } }),
      };
      fetchMock.mockResolvedValueOnce(failure as any);
      fetchMock.mockResolvedValueOnce(failure as any);
      fetchMock.mockResolvedValueOnce(failure as any);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          server: { id: 7, name: "x", status: "initializing", server_type: { name: "cax21" }, datacenter: { location: { name: "fsn1" } }, public_net: {}, labels: {}, created: new Date().toISOString() },
          root_password: null,
        }),
      } as any);

      try {
        const result = await createServer({
          name: "test",
          serverTypes: ["cax11", "cax21"],
          locations: ["hel1", "fsn1", "nbg1"],
        });

        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(result.server.id).toBe(7);
        const bodies = fetchMock.mock.calls.map(([, init]: any) => JSON.parse(init.body));
        // Outer: hel1 first → both server types tried in hel1 before fsn1.
        expect(bodies[0]).toMatchObject({ server_type: "cax11", location: "hel1" });
        expect(bodies[1]).toMatchObject({ server_type: "cax21", location: "hel1" });
        expect(bodies[2]).toMatchObject({ server_type: "cax11", location: "fsn1" });
        expect(bodies[3]).toMatchObject({ server_type: "cax21", location: "fsn1" });
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("server-type fallback: unsupported_error counts as capacity error", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn();
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      // First type triggers unsupported_error (e.g. typo), second succeeds.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error: { code: "unsupported_error", message: "server type not supported" } }),
      } as any);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          server: { id: 5, name: "x", status: "initializing", server_type: { name: "cax21" }, datacenter: { location: { name: "hel1" } }, public_net: {}, labels: {}, created: new Date().toISOString() },
          root_password: null,
        }),
      } as any);

      try {
        const result = await createServer({
          name: "test",
          serverTypes: ["typo-type", "cax21"],
          locations: ["hel1"],
        });
        expect(result.server.id).toBe(5);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("single-combination capacity error throws immediately (no infinite retry)", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 412,
        json: async () => ({ error: { code: "placement_error", message: "no capacity" } }),
      });
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      try {
        await expect(
          createServer({ name: "test", serverTypes: ["cax21"], locations: ["hel1"] })
        ).rejects.toThrow(/Hetzner API: 412/);
        // totalCombinations === 1 → must NOT loop, must throw on first failure.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("location fallback: non-capacity errors do NOT trigger fallback", async () => {
      const origToken = process.env.HETZNER_API_TOKEN;
      process.env.HETZNER_API_TOKEN = "test-token";
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: "unauthorized", message: "bad token" } }),
      });
      const origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as any;

      try {
        await expect(
          createServer({ name: "test", locations: ["hel1", "fsn1"] })
        ).rejects.toThrow(/401/);
        // Must stop after the first non-capacity error.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = origFetch;
        if (origToken) process.env.HETZNER_API_TOKEN = origToken;
        else delete process.env.HETZNER_API_TOKEN;
      }
    });

    it("tears down VPN tunnel before self-cleanup curl", () => {
      const cloudInit = generateCloudInit(defaultParams);

      // VPN teardown must appear before the cleanup curl
      const vpnTeardownPos = cloudInit.indexOf("Tearing down VPN tunnel");
      const cleanupPos = cloudInit.indexOf("Requesting self-cleanup via API");
      expect(vpnTeardownPos).toBeGreaterThan(-1);
      expect(cleanupPos).toBeGreaterThan(-1);
      expect(vpnTeardownPos).toBeLessThan(cleanupPos);

      // Must handle both WireGuard and OpenVPN
      expect(cloudInit).toContain("wg-quick down wg0");
      expect(cloudInit).toContain("killall openvpn");

      // Must flush iptables kill-switch after VPN teardown
      const iptablesFlushPos = cloudInit.indexOf("iptables -F OUTPUT");
      expect(iptablesFlushPos).toBeGreaterThan(vpnTeardownPos);
      expect(iptablesFlushPos).toBeLessThan(cleanupPos);
      expect(cloudInit).toContain("iptables -P OUTPUT ACCEPT");
      expect(cloudInit).toContain("ip6tables -F OUTPUT");

      // Must restore DNS after VPN teardown
      expect(cloudInit).toContain("nameserver 1.1.1.1");
      expect(cloudInit).toContain("nameserver 8.8.8.8");

      // Must verify API connectivity before cleanup
      expect(cloudInit).toContain("/health");
    });
  });
});

// Route tests — mocked Hetzner API to avoid real server creation
describe("Download VPS Routes", () => {
  it("provision endpoint requires Hetzner config", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id },
    });

    const origToken = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/provision`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("nicht konfiguriert");
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
    }
  });

  it("provision endpoint rejects non-queued jobs", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test2-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash2-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id, status: "downloading" },
    });

    const origToken = process.env.HETZNER_API_TOKEN;
    const origApiBase = process.env.API_BASE_URL;
    const origS3Key = process.env.S3_ACCESS_KEY;
    const origS3Secret = process.env.S3_SECRET_KEY;
    const origS3Endpoint = process.env.S3_ENDPOINT;
    const origS3Bucket = process.env.S3_BUCKET;
    const origUsenetHost = process.env.USENET_HOST;
    const origUsenetUser = process.env.USENET_USER;
    const origUsenetPass = process.env.USENET_PASSWORD;
    const origNzbService = process.env.NZB_SERVICE_URL;

    process.env.HETZNER_API_TOKEN = "fake-token-for-test";
    process.env.API_BASE_URL = "http://localhost:4000";
    process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "test-key";
    process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || "test-secret";
    process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || "https://hel1.test.com";
    process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
    process.env.USENET_HOST = process.env.USENET_HOST || "news.test.com";
    process.env.USENET_USER = process.env.USENET_USER || "user";
    process.env.USENET_PASSWORD = process.env.USENET_PASSWORD || "pass";
    process.env.NZB_SERVICE_URL = process.env.NZB_SERVICE_URL || "http://localhost:3001";

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/provision`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("queued");
    } finally {
      // Restore all env vars
      const restore = (key: string, orig: string | undefined) => {
        if (orig !== undefined) process.env[key] = orig;
        else delete process.env[key];
      };
      restore("HETZNER_API_TOKEN", origToken);
      restore("API_BASE_URL", origApiBase);
      restore("S3_ACCESS_KEY", origS3Key);
      restore("S3_SECRET_KEY", origS3Secret);
      restore("S3_ENDPOINT", origS3Endpoint);
      restore("S3_BUCKET", origS3Bucket);
      restore("USENET_HOST", origUsenetHost);
      restore("USENET_USER", origUsenetUser);
      restore("USENET_PASSWORD", origUsenetPass);
      restore("NZB_SERVICE_URL", origNzbService);
    }
  });

  it("cleanup endpoint returns 404 for unknown job", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test3-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const origToken = process.env.HETZNER_API_TOKEN;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";

    try {
      const res = await request(app)
        .post("/downloads/jobs/nonexistent-id/cleanup")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
      else delete process.env.HETZNER_API_TOKEN;
    }
  });

  it("cleanup endpoint rejects jobs without server", async () => {
    const request = (await import("supertest")).default;
    const { createApp } = await import("../app.js");
    const { prisma } = await import("../test/setup.js");
    const { signToken } = await import("../middleware/auth.js");

    const app = createApp();

    const user = await prisma.user.create({
      data: { email: `vps-test4-${Date.now()}@test.de`, password: "$2b$10$hash", name: "VPS Test" },
    });
    const token = signToken({ userId: user.id, email: user.email });

    const movie = await prisma.nzbMovie.create({
      data: { titleDe: "Test", titleEn: "Test", year: 2024 },
    });
    const nzbFile = await prisma.nzbFile.create({
      data: { movieId: movie.id, hash: `vpshash4-${Date.now()}`, originalFilename: "test.nzb" },
    });
    const job = await prisma.downloadJob.create({
      data: { nzbFileId: nzbFile.id, status: "completed" },
    });

    const origToken = process.env.HETZNER_API_TOKEN;
    process.env.HETZNER_API_TOKEN = "fake-token-for-test";

    try {
      const res = await request(app)
        .post(`/downloads/jobs/${job.id}/cleanup`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("keinen zugeordneten Server");
    } finally {
      if (origToken) process.env.HETZNER_API_TOKEN = origToken;
      else delete process.env.HETZNER_API_TOKEN;
    }
  });
});
