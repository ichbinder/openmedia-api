import { describe, it, expect } from "vitest";
import {
  generateCloudInit,
  generateUploadCloudInit,
  generateBootstrapScript,
  generateTrafficGuardScript,
} from "../hetzner.js";

// ─── Base params ────────────────────────────────────────────────────

const BASE_PARAMS = {
  jobId: "test-job-123",
  apiBaseUrl: "https://api.test.example.com",
  serviceToken: "svc-token-abc",
  dockerImage: "ghcr.io/test/downloader:latest",
  serverName: "dl-test-123",
};

const UPLOAD_PARAMS = {
  jobId: "upload-job-456",
  apiBaseUrl: "https://api.test.example.com",
  serviceToken: "svc-token-upload",
  serverName: "up-test-456",
};

// ─── Helper: decode base64 content from cloud-init write_files ──────

function decodeWriteFile(cloudInit: string, path: string): string {
  // Find the write_files entry for the given path using string-based parsing
  // (avoids dynamic RegExp which triggers ReDoS warnings in static analyzers)
  const pathMarker = `path: ${path}`;
  const idx = cloudInit.indexOf(pathMarker);
  if (idx === -1) return "";

  const afterPath = cloudInit.substring(idx + pathMarker.length);
  const contentPrefix = "content: ";
  const contentIdx = afterPath.indexOf(contentPrefix);
  if (contentIdx === -1) return "";

  const valueStart = contentIdx + contentPrefix.length;
  const lineEnd = afterPath.indexOf("\n", valueStart);
  const b64 = afterPath.substring(valueStart, lineEnd === -1 ? undefined : lineEnd).trim();
  if (!b64) return "";

  return Buffer.from(b64, "base64").toString("utf-8");
}

// ─── generateBootstrapScript ────────────────────────────────────────

describe("generateBootstrapScript", () => {
  it("generates a bash script with shebang", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(script).toContain("set -euo pipefail");
  });

  it("contains API bootstrap call with correct endpoint", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("/service/jobs/${JOB_ID}/bootstrap");
    expect(script).toContain("Authorization: Bearer ${SERVICE_TOKEN}");
  });

  it("uses download fail endpoint for download jobs", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain(`/downloads/jobs/${BASE_PARAMS.jobId}/status`);
  });

  it("uses upload fail endpoint for upload jobs", () => {
    const script = generateBootstrapScript({
      ...UPLOAD_PARAMS,
      jobType: "upload",
    });
    expect(script).toContain(`/uploads/${UPLOAD_PARAMS.jobId}`);
  });

  it("contains VPN protocol detection from API response", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("jq -r '.vpnConfig.protocol // empty'");
  });

  it("handles missing VPN config gracefully (exits 0)", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("No VPN config — skipping VPN setup");
    expect(script).toContain("exit 0");
  });

  // ── WireGuard support ──

  it("installs wireguard-tools for wireguard protocol", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("apt-get install -y wireguard-tools");
  });

  it("writes WireGuard config to /etc/wireguard/wg0.conf", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("/etc/wireguard/wg0.conf");
  });

  it("includes wg-quick up wg0 command", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("wg-quick up wg0");
  });

  // ── OpenVPN support ──

  it("installs openvpn for openvpn protocol", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("apt-get install -y openvpn");
  });

  it("writes OpenVPN config to /etc/openvpn/client.conf", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("/etc/openvpn/client.conf");
  });

  it("handles OpenVPN auth credentials (auth.txt)", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("/etc/openvpn/auth.txt");
    expect(script).toContain("auth-user-pass /etc/openvpn/auth.txt");
  });

  it("starts openvpn daemon and waits for tun0", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("openvpn --config /etc/openvpn/client.conf --daemon --log /var/log/openvpn.log");
    expect(script).toContain("ip link show tun0");
    expect(script).toContain("seq 1 30");
  });

  // ── Kill-switch ──

  it("includes iptables kill-switch rules", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("iptables -A OUTPUT -o lo -j ACCEPT");
    expect(script).toContain('iptables -A OUTPUT -o "$VPN_INTERFACE" -j ACCEPT');
    expect(script).toContain("iptables -A OUTPUT -j DROP");
    expect(script).toContain("iptables -A OUTPUT -d 169.254.169.254/32 -j ACCEPT");
    expect(script).toContain("iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT");
    expect(script).toContain("iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT");
  });

  it("includes ip6tables kill-switch rules (IPv6 leak prevention)", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("ip6tables -A OUTPUT -o lo -j ACCEPT");
    expect(script).toContain('ip6tables -A OUTPUT -o "$VPN_INTERFACE" -j ACCEPT');
    expect(script).toContain("ip6tables -A OUTPUT -j DROP");
  });

  it("captures default gateway before kill-switch", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("ORIG_GW=$(ip route show default");
    expect(script).toContain("ORIG_DEV=$(ip route show default");
    // Gateway capture must come before kill-switch DROP
    const gwPos = script.indexOf("ORIG_GW=");
    const dropPos = script.indexOf("iptables -A OUTPUT -j DROP");
    expect(gwPos).toBeGreaterThan(-1);
    expect(dropPos).toBeGreaterThan(-1);
    expect(gwPos).toBeLessThan(dropPos);
  });

  // ── Bypass routes ──

  it("includes dynamic bypass route loop for excludedCIDRs", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("EXCLUDED_CIDRS");
    expect(script).toContain("ip route add");
    expect(script).toContain("ip -6 route add");
  });

  it("handles IPv6 bypass with device fallback", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("ORIG_DEV6");
    expect(script).toContain("${ORIG_DEV6:-$ORIG_DEV}");
  });

  // ── Connectivity verification ──

  it("includes VPN connectivity verification", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain('curl -sf --interface "$VPN_INTERFACE"');
    expect(script).toContain("http://1.1.1.1/cdn-cgi/trace");
  });

  it("includes VPN failure handling with fail_job", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain('fail_job "VPN setup failed');
  });

  // ── VPN tunnel ordering ──

  it("sets up kill-switch before starting VPN tunnel", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    const killSwitchPos = script.indexOf("iptables -A OUTPUT -j DROP");
    const wgUpPos = script.indexOf("wg-quick up wg0");
    expect(killSwitchPos).toBeGreaterThan(-1);
    expect(wgUpPos).toBeGreaterThan(-1);
    expect(killSwitchPos).toBeLessThan(wgUpPos);
  });

  // ── DNS leak fix ──

  it("includes DNS leak fix", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("nameserver 1.1.1.1");
  });

  // ── Watchdog ──

  it("generates VPN watchdog script inline", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("/opt/vpn-watchdog.sh");
    expect(script).toContain("WATCHDOG_EOF");
    expect(script).toContain("BACKOFF_DELAYS=(5 15 30)");
    expect(script).toContain("MAX_RETRIES=3");
  });

  it("watchdog contains WireGuard reconnect commands", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("wg-quick down wg0");
    // wg-quick up wg0 appears in both main script and watchdog
    const matches = script.match(/wg-quick up wg0/g);
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("watchdog contains OpenVPN reconnect commands", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("killall -9 openvpn");
  });

  it("watchdog contains fail_job exhaustion message", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain("VPN reconnect exhausted after");
  });

  it("launches watchdog via nohup after connectivity verification", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    const connectivityPos = script.indexOf("Connectivity verified");
    const nohupPos = script.indexOf("nohup /opt/vpn-watchdog.sh");
    expect(connectivityPos).toBeGreaterThan(-1);
    expect(nohupPos).toBeGreaterThan(-1);
    expect(nohupPos).toBeGreaterThan(connectivityPos);
  });

  it("embeds correct API credentials in script", () => {
    const script = generateBootstrapScript({
      ...BASE_PARAMS,
      jobType: "download",
    });
    expect(script).toContain(`API_BASE_URL="${BASE_PARAMS.apiBaseUrl}"`);
    expect(script).toContain(`SERVICE_TOKEN="${BASE_PARAMS.serviceToken}"`);
    expect(script).toContain(`JOB_ID="${BASE_PARAMS.jobId}"`);
  });
});

// ─── generateCloudInit ──────────────────────────────────────────────

describe("generateCloudInit (dynamic bootstrap)", () => {
  it("generates valid cloud-init YAML", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).toContain("#cloud-config");
    expect(result).toContain("docker pull");
    expect(result).toContain("fail_job");
  });

  it("contains /opt/bootstrap.sh in write_files", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).toContain("/opt/bootstrap.sh");
    expect(result).toContain('permissions: "0700"');
  });

  it("bootstrap.sh is base64-encoded and decodable", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    const decoded = decodeWriteFile(result, "/opt/bootstrap.sh");
    expect(decoded).toContain("#!/usr/bin/env bash");
    expect(decoded).toContain("/service/jobs/${JOB_ID}/bootstrap");
  });

  it("runcmd runs bootstrap.sh (jq installed inside bootstrap)", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).not.toContain("apt-get install -y jq");
    expect(result).toContain("/opt/bootstrap.sh || exit 1");
  });

  it("does NOT contain static VPN configs in write_files", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).not.toContain("/etc/wireguard/wg0.conf");
    expect(result).not.toContain("/etc/openvpn/client.conf");
    expect(result).not.toContain("/etc/openvpn/auth.txt");
  });

  it("does NOT contain static VPN setup in runcmd", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    // These were previously in the static runcmd block
    expect(result).not.toContain("apt-get install -y wireguard-tools");
    expect(result).not.toContain("apt-get install -y openvpn");
    expect(result).not.toContain("wg-quick up wg0");
    expect(result).not.toContain("openvpn --config");
  });

  it("does NOT accept vpnConfig parameter", () => {
    // The function signature no longer includes vpnConfig.
    // This is a compile-time check — if vpnConfig were still accepted,
    // the TypeScript compiler would not flag it as an error.
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).toContain("#cloud-config");

    // Runtime guard: function source should not reference vpnConfig
    expect(generateCloudInit.toString()).not.toContain("vpnConfig");
  });

  it("contains env file and docker commands", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).toContain("/opt/openmedia-env");
    expect(result).toContain(BASE_PARAMS.dockerImage);
  });

  it("places bootstrap before docker commands", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    const bootstrapPos = result.indexOf("/opt/bootstrap.sh || exit 1");
    const dockerPos = result.indexOf("docker pull");
    expect(bootstrapPos).toBeGreaterThan(-1);
    expect(dockerPos).toBeGreaterThan(-1);
    expect(bootstrapPos).toBeLessThan(dockerPos);
  });

  it("contains self-cleanup for download VPS", () => {
    const result = generateCloudInit({ ...BASE_PARAMS });
    expect(result).toContain("/cleanup");
    expect(result).toContain("Self-cleanup");
  });
});

// ─── generateUploadCloudInit ────────────────────────────────────────

describe("generateUploadCloudInit (dynamic bootstrap)", () => {
  it("generates valid cloud-init YAML", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).toContain("#cloud-config");
    expect(result).toContain("docker pull");
  });

  it("contains /opt/bootstrap.sh in write_files", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).toContain("/opt/bootstrap.sh");
  });

  it("bootstrap.sh uses upload fail endpoint", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    const decoded = decodeWriteFile(result, "/opt/bootstrap.sh");
    expect(decoded).toContain(`/uploads/${UPLOAD_PARAMS.jobId}`);
  });

  it("does NOT contain static VPN configs", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).not.toContain("/etc/wireguard/wg0.conf");
    expect(result).not.toContain("/etc/openvpn/client.conf");
  });

  it("runcmd runs bootstrap.sh (jq installed inside bootstrap)", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).not.toContain("apt-get install -y jq");
    expect(result).toContain("/opt/bootstrap.sh || exit 1");
  });

  it("places bootstrap before docker commands", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    const bootstrapPos = result.indexOf("/opt/bootstrap.sh || exit 1");
    const dockerPos = result.indexOf("docker pull");
    expect(bootstrapPos).toBeGreaterThan(-1);
    expect(dockerPos).toBeGreaterThan(-1);
    expect(bootstrapPos).toBeLessThan(dockerPos);
  });

  it("does NOT contain self-cleanup (upload VPS deleted server-side)", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).not.toContain("/cleanup");
    expect(result).toContain("VPS deletion is handled by the API");
  });

  it("uses default docker image when not specified", () => {
    const result = generateUploadCloudInit({ ...UPLOAD_PARAMS });
    expect(result).toContain("ghcr.io/ichbinder/openmedia-uploader:latest");
  });

  it("uses custom docker image when specified", () => {
    const result = generateUploadCloudInit({
      ...UPLOAD_PARAMS,
      dockerImage: "custom-image:v2",
    });
    expect(result).toContain("custom-image:v2");
  });
});

// ─── generateTrafficGuardScript ───────────────────────────────────────

describe("generateTrafficGuardScript", () => {
  const script = generateTrafficGuardScript();

  it("generates a bash script with shebang", () => {
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(script).toContain("set -uo pipefail");
  });

  it("reads routing policy from /opt/routing-policy.json", () => {
    expect(script).toContain('POLICY_FILE="/opt/routing-policy.json"');
    expect(script).toContain("jq -r '.mustVpn[]?");
    expect(script).toContain("jq -r '.mustDirect[]?");
  });

  it("checks connections every 10s", () => {
    expect(script).toContain("CHECK_INTERVAL=10");
    expect(script).toContain('sleep "$CHECK_INTERVAL"');
  });

  it("uses ss to enumerate TCP connections", () => {
    expect(script).toContain("ss -tupnH state established");
  });

  it("uses ip route get to determine interface", () => {
    expect(script).toContain("ip route get");
  });

  it("resolves mustVpn hostnames to IPs via getent", () => {
    expect(script).toContain("getent ahosts");
  });

  it("reports anomalies via POST to events endpoint", () => {
    expect(script).toContain('POST "${API_BASE_URL}/service/jobs/${JOB_ID}/events"');
    expect(script).toContain('\\"eventType\\":\\"$event_type\\"');
    expect(script).toContain('\\"severity\\":\\"$severity\\"');
  });

  it("checks mustVpn connections use VPN interface", () => {
    expect(script).toContain('VPN_HOST_IPS[$vpn_key]');
    expect(script).toContain('$actual_dev" != "${VPN_INTERFACE}"');
  });

  it("checks mustDirect connections do NOT use VPN interface", () => {
    expect(script).toContain('actual_dev" = "${VPN_INTERFACE}"');
    expect(script).toContain("ip_in_cidr");
  });

  it("exits when workload containers stop (same as watchdog)", () => {
    expect(script).toContain("docker ps --format '{{.Names}}'");
    expect(script).toContain("No running containers — exiting");
    expect(script).toContain("SEEN_WORKLOAD=1");
  });

  it("waits for routing policy file before starting", () => {
    expect(script).toContain("Waiting for routing policy");
    expect(script).toContain("No routing policy file — exiting");
  });

  it("batches anomalies into a single event per cycle", () => {
    expect(script).toContain("anomalyCount");
    expect(script).toContain("connections");
    expect(script).toContain("ANOMALY_COUNT=$((ANOMALY_COUNT + 1))");
  });

  it("skips loopback and link-local addresses", () => {
    expect(script).toContain("127.*|::1|fe80:");
  });

  it("handles IPv6 peer addresses", () => {
    expect(script).toContain("[ipv6]:port");
    expect(script).toContain("grep -oP '\\[\\K[^]]+");
  });

  it("uses python3 for CIDR matching with sys.argv (no shell injection)", () => {
    expect(script).toContain("ipaddress.ip_address");
    expect(script).toContain("ipaddress.ip_network");
    // Values must be passed as sys.argv, not interpolated into Python string
    expect(script).toContain("sys.argv[1]");
    expect(script).toContain("sys.argv[2]");
    expect(script).not.toContain("ip_address('$ip')");
  });

  it("detects default interface dynamically (not hardcoded eth0)", () => {
    expect(script).toContain("ORIG_DEV=$(ip route show default");
    expect(script).toContain('ORIG_DEV="${ORIG_DEV:-eth0}"');
    // mustDirect expected field uses ORIG_DEV, not hardcoded eth0
    expect(script).toContain("expected $ORIG_DEV");
  });

  it("guards DIRECT_CIDRS iteration for empty array with set -u", () => {
    expect(script).toContain('${#DIRECT_CIDRS[@]}" -gt 0');
  });

  it("uses jq -n for safe JSON construction in anomaly events", () => {
    expect(script).toContain("jq -n --arg");
  });

  it("does not use set -e (non-fatal on ss/curl failures)", () => {
    expect(script).toContain("set -uo pipefail");
    expect(script).not.toMatch(/^set -euo pipefail/m);
  });
});

// ─── Bootstrap + Traffic Guard integration ──────────────────────────

describe("bootstrap + traffic guard integration", () => {
  const script = generateBootstrapScript({
    ...BASE_PARAMS,
    jobType: "download",
  });

  it("saves routing policy from BOOTSTRAP_JSON to /opt/routing-policy.json", () => {
    expect(script).toContain("jq '.routingPolicy // empty'");
    expect(script).toContain("/opt/routing-policy.json");
  });

  it("starts traffic guard with nohup", () => {
    expect(script).toContain("nohup /opt/traffic-guard.sh > /var/log/traffic-guard.log 2>&1 &");
  });

  it("exports JOB_ID for traffic guard", () => {
    expect(script).toContain("export JOB_ID");
  });

  it("skips traffic guard when no routing policy", () => {
    expect(script).toContain("No routing policy — Traffic Guard skipped");
  });

  it("writes traffic guard via heredoc", () => {
    expect(script).toContain("cat > /opt/traffic-guard.sh << 'TRAFFIC_GUARD_EOF'");
    expect(script).toContain("TRAFFIC_GUARD_EOF");
  });

  it("traffic guard script is embedded in bootstrap output", () => {
    // The traffic guard script should be inline in the bootstrap
    expect(script).toContain("Traffic Routing Guard");
    expect(script).toContain("ss -tupnH state established");
    expect(script).toContain("routing_anomaly");
  });

  it("traffic guard runs before watchdog (available even without VPN)", () => {
    const watchdogPos = script.indexOf("nohup /opt/vpn-watchdog.sh");
    const guardPos = script.indexOf("nohup /opt/traffic-guard.sh");
    expect(watchdogPos).toBeGreaterThan(-1);
    expect(guardPos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(watchdogPos);
  });

  it("upload bootstrap also includes traffic guard", () => {
    const uploadScript = generateBootstrapScript({
      ...UPLOAD_PARAMS,
      jobType: "upload",
    });
    expect(uploadScript).toContain("traffic-guard.sh");
    expect(uploadScript).toContain("routing-policy.json");
  });
});

// ─── Regression: routing policy without vpnConfig ────────────────────

describe("bootstrap with routingPolicy but no vpnConfig", () => {
  const script = generateBootstrapScript({
    ...BASE_PARAMS,
    jobType: "download",
  });

  it("saves routing policy even when vpnConfig is absent", () => {
    // The script should contain the jq routingPolicy handling
    // regardless of whether vpnConfig is present
    expect(script).toContain("jq '.routingPolicy // empty'");
    expect(script).toContain("/opt/routing-policy.json");
  });

  it("writes and starts traffic guard before the vpnConfig check", () => {
    const routingPolicyPos = script.indexOf("jq '.routingPolicy // empty'");
    const vpnCheckPos = script.indexOf("vpnConfig.protocol // empty");
    expect(routingPolicyPos).toBeGreaterThan(-1);
    expect(vpnCheckPos).toBeGreaterThan(-1);
    // Routing policy handling must come before the VPN early-exit
    expect(routingPolicyPos).toBeLessThan(vpnCheckPos);
  });

  it("contains traffic guard setup in the routing policy block", () => {
    expect(script).toContain("traffic-guard.sh");
    expect(script).toContain("nohup /opt/traffic-guard.sh");
  });
});
