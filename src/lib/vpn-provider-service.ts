/**
 * VPN Provider Service — CRUD with AES-256-GCM encryption for configBlob,
 * optional username and password.
 *
 * Follows the same pattern as usenet-provider-service.ts.
 */

import prisma from "./prisma.js";
import { encrypt, decrypt, isEncryptionConfigured } from "./crypto.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface CreateVpnProviderInput {
  name: string;
  configBlob: string;
  username?: string | null;
  password?: string | null;
  enabled?: boolean;
}

export interface UpdateVpnProviderInput {
  name?: string;
  configBlob?: string;
  username?: string | null;
  password?: string | null;
  enabled?: boolean;
}

export interface VpnProviderResult {
  id: string;
  name: string;
  protocol: string;
  configBlob: string; // masked or decrypted
  username: string | null;
  password: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MASKED = "••••••••";

// ─── Protocol Detection ──────────────────────────────────────────────

/** Detect VPN protocol from config blob content. */
function detectProtocol(configBlob: string): string {
  // WireGuard: contains [Interface] and [Peer] sections
  if (/\[Interface\]/i.test(configBlob) && /\[Peer\]/i.test(configBlob)) {
    return "wireguard";
  }
  // OpenVPN: contains 'client' directive and 'dev tun' or 'dev tap'
  if (/^\s*client\b/m.test(configBlob) && /^\s*dev\s+(tun|tap)/m.test(configBlob)) {
    return "openvpn";
  }
  throw new Error("Unrecognized VPN config format. Expected WireGuard ([Interface]+[Peer]) or OpenVPN (client+dev tun/tap).");
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export async function createVpnProvider(input: CreateVpnProviderInput): Promise<VpnProviderResult> {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
  }

  if (!input.configBlob || !input.configBlob.trim()) {
    throw new Error("configBlob must not be empty.");
  }

  const protocol = detectProtocol(input.configBlob);
  const encBlob = encrypt(input.configBlob);

  const data: Record<string, unknown> = {
    name: input.name,
    protocol,
    configBlob: encBlob.ciphertext,
    configBlobIv: encBlob.iv,
    configBlobTag: encBlob.tag,
    enabled: input.enabled ?? true,
  };

  if (input.username) {
    const encUser = encrypt(input.username);
    data.username = encUser.ciphertext;
    data.usernameIv = encUser.iv;
    data.usernameTag = encUser.tag;
  }

  if (input.password) {
    const encPass = encrypt(input.password);
    data.password = encPass.ciphertext;
    data.passwordIv = encPass.iv;
    data.passwordTag = encPass.tag;
  }

  const provider = await prisma.vpnProvider.create({ data: data as any });
  return toResult(provider, false);
}

export async function listVpnProviders(reveal = false): Promise<VpnProviderResult[]> {
  const providers = await prisma.vpnProvider.findMany({
    orderBy: [{ name: "asc" }],
  });
  return providers.map((p) => toResult(p, reveal));
}

export async function getVpnProviderById(id: string, reveal = false): Promise<VpnProviderResult | null> {
  const provider = await prisma.vpnProvider.findUnique({ where: { id } });
  if (!provider) return null;
  return toResult(provider, reveal);
}

export async function updateVpnProvider(id: string, input: UpdateVpnProviderInput): Promise<VpnProviderResult | null> {
  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.enabled !== undefined) data.enabled = input.enabled;

  if (input.configBlob !== undefined) {
    if (!input.configBlob || !input.configBlob.trim()) {
      throw new Error("configBlob must not be empty.");
    }
    if (!isEncryptionConfigured()) {
      throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
    }
    const protocol = detectProtocol(input.configBlob);
    const encBlob = encrypt(input.configBlob);
    data.protocol = protocol;
    data.configBlob = encBlob.ciphertext;
    data.configBlobIv = encBlob.iv;
    data.configBlobTag = encBlob.tag;
  }

  if (input.username !== undefined) {
    if (input.username) {
      if (!isEncryptionConfigured()) {
        throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
      }
      const encUser = encrypt(input.username);
      data.username = encUser.ciphertext;
      data.usernameIv = encUser.iv;
      data.usernameTag = encUser.tag;
    } else {
      data.username = null;
      data.usernameIv = null;
      data.usernameTag = null;
    }
  }

  if (input.password !== undefined) {
    if (input.password) {
      if (!isEncryptionConfigured()) {
        throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
      }
      const encPass = encrypt(input.password);
      data.password = encPass.ciphertext;
      data.passwordIv = encPass.iv;
      data.passwordTag = encPass.tag;
    } else {
      data.password = null;
      data.passwordIv = null;
      data.passwordTag = null;
    }
  }

  try {
    const updated = await prisma.vpnProvider.update({
      where: { id },
      data,
    });
    return toResult(updated, false);
  } catch (err: any) {
    if (err?.code === "P2025") return null;
    throw err;
  }
}

export async function deleteVpnProvider(id: string): Promise<boolean> {
  try {
    await prisma.vpnProvider.delete({ where: { id } });
    return true;
  } catch (err: any) {
    if (err?.code === "P2025") return false;
    throw err;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface VpnProviderRow {
  id: string;
  name: string;
  protocol: string;
  configBlob: string;
  configBlobIv: string;
  configBlobTag: string;
  username: string | null;
  usernameIv: string | null;
  usernameTag: string | null;
  password: string | null;
  passwordIv: string | null;
  passwordTag: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toResult(row: VpnProviderRow, reveal: boolean): VpnProviderResult {
  let configBlob = MASKED;
  let username: string | null = row.username ? MASKED : null;
  let password: string | null = row.password ? MASKED : null;

  if (reveal) {
    try {
      configBlob = decrypt(row.configBlob, row.configBlobIv, row.configBlobTag);
    } catch {
      configBlob = "[decryption failed]";
    }

    if (row.username && row.usernameIv && row.usernameTag) {
      try {
        username = decrypt(row.username, row.usernameIv, row.usernameTag);
      } catch {
        username = "[decryption failed]";
      }
    }

    if (row.password && row.passwordIv && row.passwordTag) {
      try {
        password = decrypt(row.password, row.passwordIv, row.passwordTag);
      } catch {
        password = "[decryption failed]";
      }
    }
  }

  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    configBlob,
    username,
    password,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
