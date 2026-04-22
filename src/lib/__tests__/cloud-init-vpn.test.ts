import { describe, it, expect } from "vitest";
import {
  generateCloudInit,
  generateUploadCloudInit,
} from "../hetzner.js";
import type { VpnConfigResolved } from "../vpn-config.js";

// ─── Sample VPN configs ─────────────────────────────────────────────

const SAMPLE_OPENVPN_CONFIG: VpnConfigResolved = {
  providerId: "vpn-ovpn-1",
  providerName: "Test OpenVPN",
  protocol: "openvpn",
  configBlob: `client
dev tun
proto udp
remote 203.0.113.50 1194
resolv-retry infinite
nobind
persist-key
persist-tun
cipher AES-256-GCM
auth SHA256
verb 3`,
  allowedIPs: [],
  excludedCIDRs: ["169.254.169.254/32", "10.0.0.0/8"],
  username: "testuser",
  password: "testpass",
};

const SAMPLE_OPENVPN_NO_CREDS: VpnConfigResolved = {
  ...SAMPLE_OPENVPN_CONFIG,
  providerName: "Test OpenVPN NoCreds",
  username: null,
  password: null,
};

const SAMPLE_OPENVPN_EXISTING_AUTH: VpnConfigResolved = {
  ...SAMPLE_OPENVPN_CONFIG,
  configBlob: `client
dev tun
proto udp
remote 203.0.113.50 1194
auth-user-pass /old/path.txt
cipher AES-256-GCM`,
};

const SAMPLE_OPENVPN_NO_BYPASS: VpnConfigResolved = {
  ...SAMPLE_OPENVPN_CONFIG,
  excludedCIDRs: [],
};

const SAMPLE_VPN_CONFIG: VpnConfigResolved = {
  providerId: "vpn-test-1",
  providerName: "Test VPN",
  protocol: "wireguard",
  configBlob: `[Interface]
PrivateKey = testkey123456789=
Address = 10.66.66.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = peerpubkey987654=
Endpoint = 198.51.100.1:51820
AllowedIPs = 128.0.0.0/1, 0.0.0.0/5, 8.0.0.0/7
PersistentKeepalive = 25`,
  allowedIPs: ["128.0.0.0/1", "0.0.0.0/5", "8.0.0.0/7"],
  excludedCIDRs: ["169.254.169.254/32", "10.0.0.0/8"],
  username: null,
  password: null,
};

const BASE_PARAMS = {
  jobId: "test-job-123",
  apiBaseUrl: "https://api.test.example.com",
  serviceToken: "svc-token-abc",
  dockerImage: "ghcr.io/test/downloader:latest",
  serverName: "dl-test-123",
};

// ─── generateCloudInit ──────────────────────────────────────────────

describe("generateCloudInit", () => {
  describe("without VPN (R017: unchanged cloud-init)", () => {
    it("generates valid cloud-init without VPN blocks", () => {
      const result = generateCloudInit({ ...BASE_PARAMS });
      expect(result).toContain("#cloud-config");
      expect(result).toContain("docker pull");
      expect(result).not.toContain("wireguard");
      expect(result).not.toContain("wg-quick");
      expect(result).not.toContain("iptables");
      expect(result).not.toContain("ip6tables");
      expect(result).not.toContain("/etc/wireguard");
    });

    it("generates valid cloud-init with vpnConfig=null", () => {
      const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: null });
      expect(result).toContain("#cloud-config");
      expect(result).not.toContain("wireguard");
      expect(result).not.toContain("iptables");
    });

    it("contains env file and docker commands", () => {
      const result = generateCloudInit({ ...BASE_PARAMS });
      expect(result).toContain("/opt/openmedia-env");
      expect(result).toContain(BASE_PARAMS.dockerImage);
      expect(result).toContain("fail_job");
    });
  });

  describe("with VPN", () => {
    it("includes WireGuard config write_files block", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("/etc/wireguard/wg0.conf");
      expect(result).toContain('permissions: "0600"');
      expect(result).toContain("encoding: b64");
    });

    it("includes wireguard-tools installation", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("apt-get install -y wireguard-tools");
    });

    it("includes wg-quick up command", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("wg-quick up wg0");
    });

    it("includes iptables kill-switch rules", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      // Kill-switch rules
      expect(result).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
      expect(result).toContain("iptables -A OUTPUT -o wg0 -j ACCEPT");
      expect(result).toContain("iptables -A OUTPUT -j DROP");
      // Endpoint allow rule
      expect(result).toContain("iptables -A OUTPUT -d 198.51.100.1 -j ACCEPT");
      // Cloud metadata + private network
      expect(result).toContain("iptables -A OUTPUT -d 169.254.169.254/32 -j ACCEPT");
      expect(result).toContain("iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT");
      // Established connections
      expect(result).toContain("iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT");
    });

    it("includes ip6tables kill-switch rules (IPv6 leak prevention)", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("ip6tables -A OUTPUT -o lo -j ACCEPT");
      expect(result).toContain("ip6tables -A OUTPUT -j DROP");
    });

    it("includes VPN connectivity verification", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("curl -sf --interface wg0");
    });

    it("includes VPN failure handling with fail_job", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain('fail_job "VPN setup failed');
    });

    it("places VPN setup before docker commands", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      const vpnPos = result.indexOf("wg-quick up wg0");
      const dockerPos = result.indexOf("docker pull");
      expect(vpnPos).toBeGreaterThan(-1);
      expect(dockerPos).toBeGreaterThan(-1);
      expect(vpnPos).toBeLessThan(dockerPos);
    });

    it("base64-encodes the WireGuard config blob", () => {
      const result = generateCloudInit({
        ...BASE_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      const expectedB64 = Buffer.from(SAMPLE_VPN_CONFIG.configBlob).toString(
        "base64"
      );
      expect(result).toContain(expectedB64);
    });
  });
});

// ─── OpenVPN cloud-init ─────────────────────────────────────────────

describe("generateCloudInit with OpenVPN", () => {
  it("writes /etc/openvpn/client.conf with base64-encoded config", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("/etc/openvpn/client.conf");
    expect(result).toContain('permissions: "0600"');
    expect(result).toContain("encoding: b64");
    expect(result).not.toContain("/etc/wireguard");
  });

  it("writes auth.txt when credentials present", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("/etc/openvpn/auth.txt");
    const authBase64 = Buffer.from("testuser\ntestpass").toString("base64");
    expect(result).toContain(authBase64);
  });

  it("injects auth-user-pass directive into config blob when credentials present", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    // The base64-encoded config should contain auth-user-pass
    const confMatch = result.match(/path: \/etc\/openvpn\/client\.conf[\s\S]*?content: (\S+)/);
    expect(confMatch).toBeTruthy();
    const decoded = Buffer.from(confMatch![1], "base64").toString("utf-8");
    expect(decoded).toContain("auth-user-pass /etc/openvpn/auth.txt");
  });

  it("does NOT write auth.txt file or inject auth-user-pass without credentials", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_NO_CREDS });
    expect(result).toContain("/etc/openvpn/client.conf");
    // write_files section must NOT contain auth.txt path
    const writeFilesSection = result.split("runcmd:")[0];
    expect(writeFilesSection).not.toContain("/etc/openvpn/auth.txt");
    // Decode the config and verify no auth-user-pass
    const confMatch = result.match(/path: \/etc\/openvpn\/client\.conf[\s\S]*?content: (\S+)/);
    const decoded = Buffer.from(confMatch![1], "base64").toString("utf-8");
    expect(decoded).not.toContain("auth-user-pass");
  });

  it("replaces existing auth-user-pass line (no duplication)", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_EXISTING_AUTH });
    const confMatch = result.match(/path: \/etc\/openvpn\/client\.conf[\s\S]*?content: (\S+)/);
    const decoded = Buffer.from(confMatch![1], "base64").toString("utf-8");
    // Should have exactly one auth-user-pass line
    const matches = decoded.match(/auth-user-pass/g);
    expect(matches).toHaveLength(1);
    expect(decoded).toContain("auth-user-pass /etc/openvpn/auth.txt");
    expect(decoded).not.toContain("/old/path.txt");
  });

  it("includes openvpn installation in runcmd", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("apt-get install -y openvpn");
  });

  it("includes iptables kill-switch with tun0 and remote IP", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
    expect(result).toContain("iptables -A OUTPUT -d 203.0.113.50 -j ACCEPT");
    expect(result).toContain("iptables -A OUTPUT -o tun0 -j ACCEPT");
    expect(result).toContain("iptables -A OUTPUT -j DROP");
    expect(result).toContain("ip6tables -A OUTPUT -o lo -j ACCEPT");
    expect(result).toContain("ip6tables -A OUTPUT -j DROP");
  });

  it("includes openvpn daemon start and tun0 poll loop", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log");
    expect(result).toContain("ip link show tun0");
    expect(result).toContain("seq 1 30");
  });

  it("includes bypass routes for excludedCIDRs", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("ip route add 169.254.169.254/32 via $ORIG_GW dev eth0");
    expect(result).toContain("ip route add 10.0.0.0/8 via $ORIG_GW dev eth0");
  });

  it("generates no bypass routes when excludedCIDRs is empty", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_NO_BYPASS });
    expect(result).not.toContain("ip route add");
  });

  it("includes DNS leak fix and does NOT prematurely remove auth.txt", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("nameserver 1.1.1.1");
    // auth.txt must NOT be removed in runcmd — the watchdog needs it for reconnects
    expect(result).not.toContain("rm -f /etc/openvpn/auth.txt");
  });

  it("includes connectivity check through tun0", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("curl -sf --interface tun0 https://ifconfig.me");
  });

  it("places VPN setup before docker commands", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    const vpnPos = result.indexOf("openvpn --config");
    const dockerPos = result.indexOf("docker pull");
    expect(vpnPos).toBeGreaterThan(-1);
    expect(dockerPos).toBeGreaterThan(-1);
    expect(vpnPos).toBeLessThan(dockerPos);
  });

  it("includes failure handling with fail_job", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain('fail_job "VPN setup failed');
  });
});

describe("generateUploadCloudInit with OpenVPN", () => {
  const UPLOAD_PARAMS = {
    jobId: "upload-job-456",
    apiBaseUrl: "https://api.test.example.com",
    serviceToken: "svc-token-upload",
    serverName: "up-test-456",
  };

  it("includes OpenVPN config and kill-switch in upload cloud-init", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("/etc/openvpn/client.conf");
    expect(result).toContain("openvpn --config");
    expect(result).toContain("iptables -A OUTPUT -o tun0 -j ACCEPT");
    expect(result).toContain("iptables -A OUTPUT -j DROP");
  });
});

// ─── VPN Watchdog ───────────────────────────────────────────────────

describe("VPN Watchdog", () => {
  const UPLOAD_PARAMS_WD = {
    jobId: "upload-job-456",
    apiBaseUrl: "https://api.test.example.com",
    serviceToken: "svc-token-upload",
    serverName: "up-test-456",
  };

  /** Extract and decode the base64-encoded watchdog script from cloud-init output */
  function decodeWatchdog(cloudInit: string): string {
    const match = cloudInit.match(
      /path: \/opt\/vpn-watchdog\.sh[\s\S]*?content: (\S+)/
    );
    expect(match).toBeTruthy();
    return Buffer.from(match![1], "base64").toString("utf-8");
  }

  it("WireGuard download cloud-init contains vpn-watchdog.sh in write_files", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    expect(result).toContain("/opt/vpn-watchdog.sh");
  });

  it("OpenVPN download cloud-init contains vpn-watchdog.sh in write_files", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    expect(result).toContain("/opt/vpn-watchdog.sh");
  });

  it("watchdog script contains BACKOFF_DELAYS=(5 15 30)", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain("BACKOFF_DELAYS=(5 15 30)");
  });

  it("watchdog script contains MAX_RETRIES=3", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain("MAX_RETRIES=3");
  });

  it("WireGuard watchdog contains wg-quick reconnect commands", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain("wg-quick down wg0");
    expect(watchdog).toContain("wg-quick up wg0");
  });

  it("OpenVPN watchdog contains killall+restart reconnect", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_OPENVPN_CONFIG });
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain("killall -9 openvpn");
    expect(watchdog).toContain("openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log");
  });

  it("watchdog contains fail_job call with exhaustion message", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain("VPN reconnect exhausted after");
  });

  it("nohup watchdog launch appears after connectivity verification", () => {
    const result = generateCloudInit({ ...BASE_PARAMS, vpnConfig: SAMPLE_VPN_CONFIG });
    const connectivityPos = result.indexOf("Connectivity verified");
    const watchdogLaunchPos = result.indexOf("nohup /opt/vpn-watchdog.sh");
    expect(connectivityPos).toBeGreaterThan(-1);
    expect(watchdogLaunchPos).toBeGreaterThan(-1);
    expect(watchdogLaunchPos).toBeGreaterThan(connectivityPos);
  });

  it("upload cloud-init contains watchdog with correct endpoint", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS_WD, vpnConfig: SAMPLE_VPN_CONFIG });
    expect(result).toContain("/opt/vpn-watchdog.sh");
    const watchdog = decodeWatchdog(result);
    expect(watchdog).toContain(`/uploads/${UPLOAD_PARAMS_WD.jobId}`);
  });

  it("no vpnConfig → no watchdog in write_files", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).not.toContain("vpn-watchdog.sh");
    const resultNull = generateCloudInit({ ...BASE_PARAMS, vpnConfig: null });
    expect(resultNull).not.toContain("vpn-watchdog.sh");
  });

  it("no vpnConfig → no nohup watchdog in runcmd", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).not.toContain("nohup /opt/vpn-watchdog.sh");
    const resultNull = generateCloudInit({ ...BASE_PARAMS, vpnConfig: null });
    expect(resultNull).not.toContain("nohup /opt/vpn-watchdog.sh");
  });
});

// ─── generateUploadCloudInit ────────────────────────────────────────

describe("generateUploadCloudInit", () => {
  const UPLOAD_PARAMS = {
    jobId: "upload-job-456",
    apiBaseUrl: "https://api.test.example.com",
    serviceToken: "svc-token-upload",
    serverName: "up-test-456",
  };

  describe("without VPN", () => {
    it("generates valid cloud-init without VPN blocks", () => {
      const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
      expect(result).toContain("#cloud-config");
      expect(result).toContain("docker pull");
      expect(result).not.toContain("wireguard");
      expect(result).not.toContain("wg-quick");
      expect(result).not.toContain("iptables");
    });
  });

  describe("with VPN", () => {
    it("includes WireGuard + kill-switch in upload cloud-init", () => {
      const result = generateUploadCloudInit({
        ...UPLOAD_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("/etc/wireguard/wg0.conf");
      expect(result).toContain("wg-quick up wg0");
      expect(result).toContain("iptables -A OUTPUT -o wg0 -j ACCEPT");
      expect(result).toContain("iptables -A OUTPUT -j DROP");
      expect(result).toContain("ip6tables -A OUTPUT -j DROP");
    });

    it("extracts endpoint IP for iptables allow rule", () => {
      const result = generateUploadCloudInit({
        ...UPLOAD_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      expect(result).toContain("iptables -A OUTPUT -d 198.51.100.1 -j ACCEPT");
    });

    it("places VPN setup before docker commands", () => {
      const result = generateUploadCloudInit({
        ...UPLOAD_PARAMS,
        vpnConfig: SAMPLE_VPN_CONFIG,
      });
      const vpnPos = result.indexOf("wg-quick up wg0");
      const dockerPos = result.indexOf("docker pull");
      expect(vpnPos).toBeLessThan(dockerPos);
    });
  });
});
