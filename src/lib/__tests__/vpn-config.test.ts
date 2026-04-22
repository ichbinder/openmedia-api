import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveBypassList,
  calculateAllowedIPs,
  parseWireGuardConfig,
  resolveVpnConfig,
} from "../vpn-config.js";

// ─── Mock dependencies ──────────────────────────────────────────────

// Mock DNS resolution
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
}));

// Mock VPN provider service
vi.mock("../vpn-provider-service.js", () => ({
  getVpnProviderById: vi.fn(),
}));

import { resolve4 } from "node:dns/promises";
import { getVpnProviderById } from "../vpn-provider-service.js";

const mockedResolve4 = vi.mocked(resolve4);
const mockedGetVpnProviderById = vi.mocked(getVpnProviderById);

// ─── Sample WireGuard config ────────────────────────────────────────

const SAMPLE_WG_CONFIG = `[Interface]
PrivateKey = aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890=
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = xYzAbCdEfGhIjKlMnOpQrStUvWxYz1234567890=
Endpoint = 198.51.100.1:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25`;

// ─── resolveBypassList ──────────────────────────────────────────────

describe("resolveBypassList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns default bypass CIDRs when list is empty", async () => {
    const result = await resolveBypassList([]);
    expect(result).toContain("169.254.169.254/32");
    expect(result).toContain("10.0.0.0/8");
    expect(result).toHaveLength(2);
  });

  it("passes through CIDR entries directly", async () => {
    const result = await resolveBypassList([{ value: "192.168.1.0/24" }]);
    expect(result).toContain("192.168.1.0/24");
    expect(result).toContain("169.254.169.254/32");
    expect(result).toContain("10.0.0.0/8");
  });

  it("converts plain IPs to /32 CIDRs", async () => {
    const result = await resolveBypassList([{ value: "1.2.3.4" }]);
    expect(result).toContain("1.2.3.4/32");
  });

  it("resolves hostnames via DNS", async () => {
    mockedResolve4.mockResolvedValue(["93.184.216.34"]);
    const result = await resolveBypassList([{ value: "example.com" }]);
    expect(mockedResolve4).toHaveBeenCalledWith("example.com");
    expect(result).toContain("93.184.216.34/32");
  });

  it("skips empty/whitespace entries", async () => {
    const result = await resolveBypassList([{ value: "" }, { value: "  " }]);
    expect(result).toHaveLength(2); // only defaults
  });

  it("warns and skips on DNS resolution failure", async () => {
    mockedResolve4.mockRejectedValue(new Error("ENOTFOUND"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveBypassList([{ value: "nonexistent.invalid" }]);

    expect(result).toHaveLength(2); // only defaults
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DNS resolution failed")
    );
    warnSpy.mockRestore();
  });

  it("handles multiple hostnames resolving to multiple IPs", async () => {
    mockedResolve4.mockResolvedValue(["1.1.1.1", "2.2.2.2"]);
    const result = await resolveBypassList([{ value: "multi.example.com" }]);
    expect(result).toContain("1.1.1.1/32");
    expect(result).toContain("2.2.2.2/32");
    expect(result).toHaveLength(4); // 2 defaults + 2 resolved
  });

  it("handles 20+ entries in bypass list", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      value: `192.168.${i}.0/24`,
    }));
    const result = await resolveBypassList(entries);
    expect(result).toHaveLength(27); // 2 defaults + 25 CIDRs
  });
});

// ─── calculateAllowedIPs ───────────────────────────────────────────

describe("calculateAllowedIPs", () => {
  it("returns 0.0.0.0/0 when no CIDRs to exclude", () => {
    const result = calculateAllowedIPs([]);
    expect(result).toEqual(["0.0.0.0/0"]);
  });

  it("excludes a single CIDR from 0.0.0.0/0", () => {
    const result = calculateAllowedIPs(["10.0.0.0/8"]);
    expect(result).not.toContain("0.0.0.0/0");
    expect(result.length).toBeGreaterThan(0);
    // The result should not include any 10.x.x.x addresses
    for (const cidr of result) {
      expect(cidr).not.toMatch(/^10\./);
    }
  });

  it("excludes multiple CIDRs", () => {
    const result = calculateAllowedIPs([
      "169.254.169.254/32",
      "10.0.0.0/8",
    ]);
    expect(result.length).toBeGreaterThan(0);
    // Should still cover most of the internet
    expect(result.some((c) => c.startsWith("0."))).toBe(true);
  });

  it("handles single /32 exclusion", () => {
    const result = calculateAllowedIPs(["1.2.3.4/32"]);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("1.2.3.4/32");
  });
});

// ─── parseWireGuardConfig ──────────────────────────────────────────

describe("parseWireGuardConfig", () => {
  it("replaces AllowedIPs in [Peer] section", () => {
    const result = parseWireGuardConfig(SAMPLE_WG_CONFIG, [
      "128.0.0.0/1",
      "0.0.0.0/5",
    ]);
    expect(result).toContain("AllowedIPs = 128.0.0.0/1, 0.0.0.0/5");
    expect(result).not.toContain("AllowedIPs = 0.0.0.0/0");
  });

  it("preserves other config sections", () => {
    const result = parseWireGuardConfig(SAMPLE_WG_CONFIG, ["128.0.0.0/1"]);
    expect(result).toContain("[Interface]");
    expect(result).toContain("[Peer]");
    expect(result).toContain("Endpoint = 198.51.100.1:51820");
    expect(result).toContain("PersistentKeepalive = 25");
  });

  it("handles config without AllowedIPs (returns unchanged)", () => {
    const configNoAllowed = `[Interface]
PrivateKey = abc123
Address = 10.0.0.1/32

[Peer]
PublicKey = xyz456
Endpoint = 1.2.3.4:51820`;

    const result = parseWireGuardConfig(configNoAllowed, ["128.0.0.0/1"]);
    expect(result).toBe(configNoAllowed); // unchanged
  });

  it("handles AllowedIPs with leading spaces", () => {
    const configSpaced = `[Peer]
  AllowedIPs = 0.0.0.0/0`;
    const result = parseWireGuardConfig(configSpaced, [
      "192.168.0.0/16",
    ]);
    expect(result).toContain("AllowedIPs = 192.168.0.0/16");
  });
});

// ─── resolveVpnConfig ──────────────────────────────────────────────

describe("resolveVpnConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when provider not found", async () => {
    mockedGetVpnProviderById.mockResolvedValue(null);
    const result = await resolveVpnConfig("nonexistent-id");
    expect(result).toBeNull();
  });

  it("returns null when provider is disabled", async () => {
    mockedGetVpnProviderById.mockResolvedValue({
      id: "test-id",
      name: "Test VPN",
      protocol: "wireguard",
      configBlob: SAMPLE_WG_CONFIG,
      enabled: false,
      username: null,
      password: null,
    } as any);
    const result = await resolveVpnConfig("test-id");
    expect(result).toBeNull();
  });

  it("resolves WireGuard config with AllowedIPs replaced", async () => {
    mockedGetVpnProviderById.mockResolvedValue({
      id: "wg-1",
      name: "WG Provider",
      protocol: "wireguard",
      configBlob: SAMPLE_WG_CONFIG,
      enabled: true,
      username: null,
      password: null,
    } as any);

    const result = await resolveVpnConfig("wg-1", []);
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe("wg-1");
    expect(result!.providerName).toBe("WG Provider");
    expect(result!.protocol).toBe("wireguard");
    // AllowedIPs should be replaced (not 0.0.0.0/0 since defaults are excluded)
    expect(result!.configBlob).not.toContain("AllowedIPs = 0.0.0.0/0");
    expect(result!.allowedIPs.length).toBeGreaterThan(0);
    expect(result!.excludedCIDRs).toContain("169.254.169.254/32");
    expect(result!.excludedCIDRs).toContain("10.0.0.0/8");
  });

  it("does not replace AllowedIPs for non-wireguard protocols", async () => {
    mockedGetVpnProviderById.mockResolvedValue({
      id: "ovpn-1",
      name: "OpenVPN Provider",
      protocol: "openvpn",
      configBlob: "some openvpn config content",
      enabled: true,
      username: "user",
      password: "pass",
    } as any);

    const result = await resolveVpnConfig("ovpn-1", []);
    expect(result).not.toBeNull();
    expect(result!.configBlob).toBe("some openvpn config content");
    expect(result!.username).toBe("user");
    expect(result!.password).toBe("pass");
  });
});
