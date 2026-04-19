/**
 * Usenet Provider Service — CRUD with AES-256-GCM password encryption.
 *
 * Providers are first-class entities that can be assigned to download
 * and/or upload services via isDownload/isUpload flags.
 */

import prisma from "./prisma.js";
import { encrypt, decrypt, isEncryptionConfigured } from "./crypto.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface CreateProviderInput {
  name: string;
  host: string;
  postHost?: string | null;
  port?: number;
  ssl?: boolean;
  username: string;
  password: string;
  connections?: number;
  priority?: number;
  enabled?: boolean;
  isDownload?: boolean;
  isUpload?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  host?: string;
  postHost?: string | null;
  port?: number;
  ssl?: boolean;
  username?: string;
  password?: string;
  connections?: number;
  priority?: number;
  enabled?: boolean;
  isDownload?: boolean;
  isUpload?: boolean;
}

export interface ProviderResult {
  id: string;
  name: string;
  host: string;
  postHost: string | null;
  port: number;
  ssl: boolean;
  username: string;
  password: string; // masked or decrypted
  connections: number;
  priority: number;
  enabled: boolean;
  isDownload: boolean;
  isUpload: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MASKED_PASSWORD = "••••••••";

// ─── CRUD ─────────────────────────────────────────────────────────────

export async function createProvider(input: CreateProviderInput): Promise<ProviderResult> {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
  }

  const enc = encrypt(input.password);

  const provider = await prisma.usenetProvider.create({
    data: {
      name: input.name,
      host: input.host,
      postHost: input.postHost ?? null,
      port: input.port ?? 563,
      ssl: input.ssl ?? true,
      username: input.username,
      password: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      connections: input.connections ?? 20,
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
      isDownload: input.isDownload ?? false,
      isUpload: input.isUpload ?? false,
    },
  });

  return toResult(provider, false);
}

export async function listProviders(reveal = false): Promise<ProviderResult[]> {
  const providers = await prisma.usenetProvider.findMany({
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });

  return providers.map((p) => toResult(p, reveal));
}

export async function getProviderById(id: string, reveal = false): Promise<ProviderResult | null> {
  const provider = await prisma.usenetProvider.findUnique({ where: { id } });
  if (!provider) return null;
  return toResult(provider, reveal);
}

export async function updateProvider(id: string, input: UpdateProviderInput): Promise<ProviderResult | null> {
  const existing = await prisma.usenetProvider.findUnique({ where: { id } });
  if (!existing) return null;

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.host !== undefined) data.host = input.host;
  if (input.postHost !== undefined) data.postHost = input.postHost;
  if (input.port !== undefined) data.port = input.port;
  if (input.ssl !== undefined) data.ssl = input.ssl;
  if (input.username !== undefined) data.username = input.username;
  if (input.connections !== undefined) data.connections = input.connections;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.isDownload !== undefined) data.isDownload = input.isDownload;
  if (input.isUpload !== undefined) data.isUpload = input.isUpload;

  if (input.password !== undefined) {
    if (!isEncryptionConfigured()) {
      throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
    }
    const enc = encrypt(input.password);
    data.password = enc.ciphertext;
    data.iv = enc.iv;
    data.tag = enc.tag;
  }

  const updated = await prisma.usenetProvider.update({
    where: { id },
    data,
  });

  return toResult(updated, false);
}

export async function deleteProvider(id: string): Promise<boolean> {
  const existing = await prisma.usenetProvider.findUnique({ where: { id } });
  if (!existing) return false;

  await prisma.usenetProvider.delete({ where: { id } });
  return true;
}

/** Get all enabled providers assigned to download. */
export async function getDownloadProviders(): Promise<ProviderResult[]> {
  const providers = await prisma.usenetProvider.findMany({
    where: { isDownload: true, enabled: true },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });

  return providers.map((p) => toResult(p, true));
}

/** Get all enabled providers assigned to upload. */
export async function getUploadProviders(): Promise<ProviderResult[]> {
  const providers = await prisma.usenetProvider.findMany({
    where: { isUpload: true, enabled: true },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });

  return providers.map((p) => toResult(p, true));
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface ProviderRow {
  id: string;
  name: string;
  host: string;
  postHost: string | null;
  port: number;
  ssl: boolean;
  username: string;
  password: string;
  iv: string | null;
  tag: string | null;
  connections: number;
  priority: number;
  enabled: boolean;
  isDownload: boolean;
  isUpload: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toResult(row: ProviderRow, reveal: boolean): ProviderResult {
  let password = MASKED_PASSWORD;
  if (reveal && row.iv && row.tag) {
    try {
      password = decrypt(row.password, row.iv, row.tag);
    } catch {
      password = "[decryption failed]";
    }
  }

  return {
    id: row.id,
    name: row.name,
    host: row.host,
    postHost: row.postHost,
    port: row.port,
    ssl: row.ssl,
    username: row.username,
    password,
    connections: row.connections,
    priority: row.priority,
    enabled: row.enabled,
    isDownload: row.isDownload,
    isUpload: row.isUpload,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
