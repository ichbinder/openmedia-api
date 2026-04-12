import type { UsenetServer } from "./hetzner.js";

/**
 * Parse Usenet server config from environment variables.
 * Prefers USENET_SERVERS (JSON array) over legacy individual variables.
 * Returns an array of UsenetServer objects sorted by priority.
 */
export function parseUsenetServersFromEnv(): UsenetServer[] {
  // Preferred: JSON array
  const serversJson = process.env.USENET_SERVERS;
  if (serversJson) {
    try {
      const parsed = JSON.parse(serversJson);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s: Record<string, unknown>, i: number) => ({
          host: String(s.host || ""),
          port: Number(s.port) || 563,
          username: String(s.username || ""),
          password: String(s.password || ""),
          ssl: s.ssl !== false && s.ssl !== "false" && s.ssl !== "0",
          connections: Number(s.connections) || 10,
          optional: Number(s.optional) || (i > 0 ? 1 : 0),
          priority: Number(s.priority) ?? i,
        })).filter((s: UsenetServer) => s.host && s.username);
      }
    } catch (e) {
      console.error("[usenet-config] Failed to parse USENET_SERVERS JSON:", e);
    }
  }

  // Legacy: individual ENV variables
  const servers: UsenetServer[] = [];

  if (process.env.USENET_HOST && process.env.USENET_USER) {
    servers.push({
      host: process.env.USENET_HOST,
      port: parseInt(process.env.USENET_PORT || "563", 10),
      username: process.env.USENET_USER,
      password: process.env.USENET_PASSWORD || "",
      ssl: process.env.USENET_SSL !== "false" && process.env.USENET_SSL !== "0",
      connections: parseInt(process.env.USENET_CONNECTIONS || "10", 10),
      optional: 0,
      priority: 0,
    });
  }

  if (process.env.USENET_BACKUP_HOST && process.env.USENET_BACKUP_USER) {
    const port = parseInt(process.env.USENET_BACKUP_PORT || "", 10);
    const conns = parseInt(process.env.USENET_BACKUP_CONNECTIONS || "", 10);
    servers.push({
      host: process.env.USENET_BACKUP_HOST,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 563,
      username: process.env.USENET_BACKUP_USER,
      password: process.env.USENET_BACKUP_PASSWORD || "",
      ssl: process.env.USENET_BACKUP_SSL !== "false",
      connections: Number.isInteger(conns) && conns >= 1 ? conns : 10,
      optional: 1,
      priority: 1,
    });
  }

  return servers;
}

/** Provider shape used by upload VPS provisioning. */
export interface UploadProvider {
  host: string;
  port: number;
  username: string;
  password: string;
  ssl: boolean;
  connections: number;
}

/**
 * Parse upload providers from USENET_PROVIDER_{1..3}_* env vars.
 * Skips slots where HOST or USER is missing. Returns 0-3 providers.
 */
export function parseUploadProvidersFromEnv(): UploadProvider[] {
  const providers: UploadProvider[] = [];
  for (let i = 1; i <= 3; i++) {
    const prefix = `USENET_PROVIDER_${i}_`;
    const host = process.env[`${prefix}HOST`];
    const user = process.env[`${prefix}USER`];
    if (!host || !user) continue;

    const rawPort = parseInt(process.env[`${prefix}PORT`] || "", 10);
    const port = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 563;

    const rawSsl = process.env[`${prefix}SSL`];
    const ssl = rawSsl !== "0" && rawSsl !== "false" && rawSsl !== "no";

    const rawConns = parseInt(process.env[`${prefix}CONNS`] || "", 10);
    const connections = Number.isInteger(rawConns) && rawConns >= 1 ? rawConns : 20;

    providers.push({ host, port, username: user, password: process.env[`${prefix}PASS`] || "", ssl, connections });
  }
  return providers;
}
