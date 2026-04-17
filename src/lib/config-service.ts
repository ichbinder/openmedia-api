/**
 * Centralized Config Service — category-based configuration store
 * with AES-256-GCM encryption for secrets and change history.
 *
 * Replaces the old flat key-value EncryptedConfig store.
 */

import prisma from "./prisma.js";
import { encrypt, decrypt, isEncryptionConfigured } from "./crypto.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface ConfigEntryInput {
  categoryName: string;
  key: string;
  value: string;
  encrypted?: boolean;
  displayName?: string;
  description?: string;
}

export interface ConfigEntryResult {
  id: string;
  categoryName: string;
  key: string;
  value: string;
  encrypted: boolean;
  displayName: string;
  description: string;
  updatedAt: Date;
}

export interface ConfigHistoryEntry {
  id: string;
  action: string;
  changedBy: string | null;
  createdAt: Date;
}

// ─── Category Operations ──────────────────────────────────────────────

export async function listCategories() {
  return prisma.configCategory.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { entries: true } } },
  });
}

export async function getCategory(name: string) {
  return prisma.configCategory.findUnique({ where: { name } });
}

export async function createCategory(data: {
  name: string;
  displayName: string;
  description?: string;
}) {
  return prisma.configCategory.create({
    data: {
      name: data.name,
      displayName: data.displayName,
      description: data.description ?? "",
    },
  });
}

// ─── Entry Operations ─────────────────────────────────────────────────

export async function getEntriesByCategory(
  categoryName: string,
  revealSecrets = false,
): Promise<ConfigEntryResult[]> {
  const category = await prisma.configCategory.findUnique({
    where: { name: categoryName },
  });
  if (!category) return [];

  const entries = await prisma.configEntry.findMany({
    where: { categoryId: category.id },
    orderBy: { key: "asc" },
    include: { category: { select: { name: true } } },
  });

  return entries.map((e) => ({
    id: e.id,
    categoryName: e.category.name,
    key: e.key,
    value: e.encrypted
      ? revealSecrets
        ? decryptValue(e.value, e.iv!, e.tag!)
        : "••••••••"
      : e.value,
    encrypted: e.encrypted,
    displayName: e.displayName,
    description: e.description,
    updatedAt: e.updatedAt,
  }));
}

export async function getEntry(
  categoryName: string,
  key: string,
  revealSecret = false,
): Promise<ConfigEntryResult | null> {
  const category = await prisma.configCategory.findUnique({
    where: { name: categoryName },
  });
  if (!category) return null;

  const entry = await prisma.configEntry.findUnique({
    where: { categoryId_key: { categoryId: category.id, key } },
    include: { category: { select: { name: true } } },
  });
  if (!entry) return null;

  return {
    id: entry.id,
    categoryName: entry.category.name,
    key: entry.key,
    value: entry.encrypted
      ? revealSecret
        ? decryptValue(entry.value, entry.iv!, entry.tag!)
        : "••••••••"
      : entry.value,
    encrypted: entry.encrypted,
    displayName: entry.displayName,
    description: entry.description,
    updatedAt: entry.updatedAt,
  };
}

export async function upsertEntry(
  input: ConfigEntryInput,
  changedBy?: string,
): Promise<ConfigEntryResult> {
  const category = await prisma.configCategory.findUnique({
    where: { name: input.categoryName },
  });
  if (!category) {
    throw new Error(`Category '${input.categoryName}' not found.`);
  }

  const isEncrypted = input.encrypted ?? false;
  let storedValue = input.value;
  let iv: string | null = null;
  let tag: string | null = null;

  if (isEncrypted) {
    if (!isEncryptionConfigured()) {
      throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
    }
    const enc = encrypt(input.value);
    storedValue = enc.ciphertext;
    iv = enc.iv;
    tag = enc.tag;
  }

  const existing = await prisma.configEntry.findUnique({
    where: { categoryId_key: { categoryId: category.id, key: input.key } },
  });

  const entry = await prisma.$transaction(async (tx) => {
    const result = await tx.configEntry.upsert({
      where: { categoryId_key: { categoryId: category.id, key: input.key } },
      create: {
        categoryId: category.id,
        key: input.key,
        value: storedValue,
        encrypted: isEncrypted,
        iv,
        tag,
        displayName: input.displayName ?? "",
        description: input.description ?? "",
      },
      update: {
        value: storedValue,
        encrypted: isEncrypted,
        iv,
        tag,
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.description !== undefined && { description: input.description }),
      },
      include: { category: { select: { name: true } } },
    });

    // Record history — store "encrypted" marker, never plaintext secrets
    await tx.configHistory.create({
      data: {
        entryId: result.id,
        action: existing ? "updated" : "created",
        oldValue: existing ? (existing.encrypted ? "[encrypted]" : existing.value) : null,
        newValue: isEncrypted ? "[encrypted]" : input.value,
        changedBy: changedBy ?? "system",
      },
    });

    return result;
  });

  return {
    id: entry.id,
    categoryName: entry.category.name,
    key: entry.key,
    value: isEncrypted ? "••••••••" : input.value,
    encrypted: isEncrypted,
    displayName: entry.displayName,
    description: entry.description,
    updatedAt: entry.updatedAt,
  };
}

export async function deleteEntry(
  categoryName: string,
  key: string,
  changedBy?: string,
): Promise<boolean> {
  const category = await prisma.configCategory.findUnique({
    where: { name: categoryName },
  });
  if (!category) return false;

  const entry = await prisma.configEntry.findUnique({
    where: { categoryId_key: { categoryId: category.id, key } },
  });
  if (!entry) return false;

  await prisma.$transaction(async (tx) => {
    await tx.configHistory.create({
      data: {
        entryId: entry.id,
        action: "deleted",
        oldValue: entry.encrypted ? "[encrypted]" : entry.value,
        newValue: null,
        changedBy: changedBy ?? "system",
      },
    });
    await tx.configEntry.delete({ where: { id: entry.id } });
  });

  return true;
}

// ─── Profile Operations ───────────────────────────────────────────────

export async function listProfiles() {
  return prisma.configProfile.findMany({
    orderBy: { name: "asc" },
    include: {
      categories: {
        include: { category: { select: { name: true, displayName: true } } },
      },
    },
  });
}

export async function getProfileConfig(
  profileName: string,
): Promise<Record<string, Record<string, string>> | null> {
  const profile = await prisma.configProfile.findUnique({
    where: { name: profileName },
    include: {
      categories: {
        include: {
          category: {
            include: {
              entries: true,
            },
          },
        },
      },
    },
  });

  if (!profile) return null;

  const result: Record<string, Record<string, string>> = {};

  for (const pc of profile.categories) {
    const catName = pc.category.name;
    result[catName] = {};

    for (const entry of pc.category.entries) {
      if (entry.encrypted) {
        result[catName][entry.key] = decryptValue(entry.value, entry.iv!, entry.tag!);
      } else {
        result[catName][entry.key] = entry.value;
      }
    }
  }

  return result;
}

// ─── History ──────────────────────────────────────────────────────────

export async function getEntryHistory(
  categoryName: string,
  key: string,
  limit = 50,
): Promise<ConfigHistoryEntry[]> {
  const category = await prisma.configCategory.findUnique({
    where: { name: categoryName },
  });
  if (!category) return [];

  const entry = await prisma.configEntry.findUnique({
    where: { categoryId_key: { categoryId: category.id, key } },
  });
  if (!entry) return [];

  return prisma.configHistory.findMany({
    where: { entryId: entry.id },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, action: true, changedBy: true, createdAt: true },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

function decryptValue(ciphertext: string, iv: string, tag: string): string {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption not configured (ENCRYPTION_MASTER_KEY missing).");
  }
  try {
    return decrypt(ciphertext, iv, tag);
  } catch {
    throw new Error("Decryption failed — wrong key or corrupted data.");
  }
}
