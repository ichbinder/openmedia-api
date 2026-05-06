/**
 * Admin Config Routes — CRUD for the centralized config store.
 *
 * All routes require auth. Secrets are masked unless ?reveal=true.
 */

import { Router, type Response } from "express";
import { requireAuth, requireAdmin, requireServiceToken, type AuthRequest } from "../middleware/auth.js";
import { isEncryptionConfigured } from "../lib/crypto.js";
import prisma from "../lib/prisma.js";
import type { Prisma } from "../../generated/client/index.js";
import {
  listCategories,
  getEntriesByCategory,
  getEntry,
  upsertEntry,
  deleteEntry,
  listProfiles,
  getProfileConfig,
  getEntryHistory,
  createCategory,
} from "../lib/config-service.js";
import {
  createProvider,
  listProviders,
  getProviderById,
  updateProvider,
  deleteProvider,
} from "../lib/usenet-provider-service.js";
import {
  createVpnProvider,
  listVpnProviders,
  getVpnProviderById,
  updateVpnProvider,
  deleteVpnProvider,
} from "../lib/vpn-provider-service.js";
import { getActiveVpsCounts, getVpsLimits } from "../lib/vps-config.js";

const router = Router();

// ─── Categories ───────────────────────────────────────────────────────

/** GET /admin/config/categories — list all categories with entry counts */
router.get("/categories", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const categories = await listCategories();
    res.json({ categories });
  } catch (err) {
    console.error("[admin-config] List categories error:", err);
    res.status(500).json({ error: "Failed to list categories." });
  }
});

/** POST /admin/config/categories — create a new category */
router.post("/categories", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, displayName, description } = req.body;
    if (!name || !displayName) {
      res.status(400).json({ error: "name and displayName are required." });
      return;
    }
    const category = await createCategory({ name, displayName, description });
    console.log(`[admin-config] Category created: ${name} by ${req.user?.userId}`);
    res.status(201).json({ category });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Category already exists." });
      return;
    }
    console.error("[admin-config] Create category error:", err);
    res.status(500).json({ error: "Failed to create category." });
  }
});

// ─── Entries ──────────────────────────────────────────────────────────

/** GET /admin/config/entries/:categoryName — list entries in a category */
router.get("/entries/:categoryName", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const entries = await getEntriesByCategory(String(req.params.categoryName), reveal);
    res.json({ entries });
  } catch (err) {
    console.error("[admin-config] List entries error:", err);
    res.status(500).json({ error: "Failed to list entries." });
  }
});

/** GET /admin/config/entries/:categoryName/:key — get a single entry */
router.get("/entries/:categoryName/:key", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const entry = await getEntry(String(req.params.categoryName), String(req.params.key), reveal);
    if (!entry) {
      res.status(404).json({ error: "Entry not found." });
      return;
    }
    res.json({ entry });
  } catch (err) {
    console.error("[admin-config] Get entry error:", err);
    res.status(500).json({ error: "Failed to get entry." });
  }
});

/** PUT /admin/config/entries — create or update an entry */
router.put("/entries", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { categoryName, key, value, encrypted, displayName, description } = req.body;

    if (!categoryName || typeof categoryName !== "string" ||
        !key || typeof key !== "string" ||
        value === undefined || value === null) {
      res.status(400).json({ error: "categoryName, key, and value are required." });
      return;
    }

    if (encrypted !== undefined && typeof encrypted !== "boolean") {
      res.status(400).json({ error: "encrypted must be a boolean." });
      return;
    }

    // Serialize objects/arrays to JSON, reject non-serializable types
    let serializedValue: string;
    try {
      serializedValue = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      res.status(400).json({ error: "Invalid request payload: non-serializable value." });
      return;
    }

    // Check encryption config upfront — covers both explicit encrypted:true
    // and implicit preservation of existing encrypted entries
    if (encrypted !== false && !isEncryptionConfigured()) {
      // Only fail if the entry will actually need encryption:
      // either explicit encrypted:true in request, or existing entry is encrypted
      const existingEntry = await getEntry(categoryName, key);
      if (encrypted || existingEntry?.encrypted) {
        res.status(503).json({ error: "Encryption not configured." });
        return;
      }
    }

    const entry = await upsertEntry(
      { categoryName, key, value: serializedValue, encrypted, displayName, description },
      req.user?.userId,
    );

    console.log(`[admin-config] Entry upserted: ${categoryName}/${key} by ${req.user?.userId}`);
    res.json({ entry });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("[admin-config] Upsert entry error:", err);
    res.status(500).json({ error: "Failed to save entry." });
  }
});

/** DELETE /admin/config/entries/:categoryName/:key — delete an entry */
router.delete("/entries/:categoryName/:key", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const deleted = await deleteEntry(
      String(req.params.categoryName),
      String(req.params.key),
      req.user?.userId,
    );
    if (!deleted) {
      res.status(404).json({ error: "Entry not found." });
      return;
    }
    console.log(`[admin-config] Entry deleted: ${String(req.params.categoryName)}/${String(req.params.key)} by ${req.user?.userId}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("[admin-config] Delete entry error:", err);
    res.status(500).json({ error: "Failed to delete entry." });
  }
});

// ─── Profiles ─────────────────────────────────────────────────────────

/** GET /admin/config/profiles — list all profiles with their category mappings */
router.get("/profiles", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const profiles = await listProfiles();
    res.json({ profiles });
  } catch (err) {
    console.error("[admin-config] List profiles error:", err);
    res.status(500).json({ error: "Failed to list profiles." });
  }
});

// ─── VPS Config Endpoint ──────────────────────────────────────────────

/** GET /admin/config/vps?type=download_vps|upload_vps — returns flat config for a VPS profile */
router.get("/vps", requireServiceToken, async (req: AuthRequest, res: Response) => {
  try {
    const profileType = req.query.type as string;
    if (!profileType) {
      res.status(400).json({ error: "Query param 'type' is required." });
      return;
    }

    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const config = await getProfileConfig(profileType);
    if (!config) {
      res.status(404).json({ error: `Profile '${profileType}' not found.` });
      return;
    }

    console.log(`[admin-config] VPS config requested: ${profileType}`);
    res.json({ profile: profileType, config });
  } catch (err) {
    console.error("[admin-config] VPS config error:", err);
    res.status(500).json({ error: "Failed to get VPS config." });
  }
});

// ─── History ──────────────────────────────────────────────────────────

/** GET /admin/config/history/:categoryName/:key — entry change history */
router.get("/history/:categoryName/:key", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const history = await getEntryHistory(String(req.params.categoryName), String(req.params.key));
    res.json({ history });
  } catch (err) {
    console.error("[admin-config] History error:", err);
    res.status(500).json({ error: "Failed to get history." });
  }
});

// ─── Usenet Provider Input Validation ─────────────────────────────────

interface ProviderValidationResult {
  error?: string;
  data: {
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
  };
}

function validateProviderInput(body: Record<string, unknown>, requireFields: boolean): ProviderValidationResult {
  const data: ProviderValidationResult["data"] = {};
  const { name, host, postHost, port, ssl, username, password, connections, priority, enabled, isDownload, isUpload } = body;

  if (requireFields) {
    if (typeof name !== "string" || !name.trim()) return { error: "name must be a non-empty string.", data };
    if (typeof host !== "string" || !host.trim()) return { error: "host must be a non-empty string.", data };
    if (typeof username !== "string" || !username.trim()) return { error: "username must be a non-empty string.", data };
    if (typeof password !== "string" || !password) return { error: "password must be a non-empty string.", data };
  }

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) return { error: "name must be a non-empty string.", data };
    data.name = name.trim();
  }
  if (host !== undefined) {
    if (typeof host !== "string" || !host.trim()) return { error: "host must be a non-empty string.", data };
    data.host = host.trim();
  }
  if (postHost !== undefined) {
    if (postHost === null || postHost === "") {
      data.postHost = null;
    } else if (typeof postHost === "string") {
      data.postHost = postHost.trim() || null;
    } else {
      return { error: "postHost must be a string or null.", data };
    }
  }
  if (username !== undefined) {
    if (typeof username !== "string" || !username.trim()) return { error: "username must be a non-empty string.", data };
    data.username = username.trim();
  }
  if (password !== undefined) {
    if (typeof password !== "string" || !password) return { error: "password must be a non-empty string.", data };
    data.password = password;
  }

  if (port !== undefined) {
    const p = typeof port === "string" ? parseInt(port, 10) : port;
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
      return { error: "port must be an integer between 1 and 65535.", data };
    }
    data.port = p;
  }
  if (connections !== undefined) {
    const c = typeof connections === "string" ? parseInt(connections, 10) : connections;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 100) {
      return { error: "connections must be an integer between 1 and 100.", data };
    }
    data.connections = c;
  }
  if (priority !== undefined) {
    const pr = typeof priority === "string" ? parseInt(priority, 10) : priority;
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 0) {
      return { error: "priority must be a non-negative integer.", data };
    }
    data.priority = pr;
  }

  const parseBool = (val: unknown, field: string): boolean | string => {
    if (typeof val === "boolean") return val;
    if (val === "true") return true;
    if (val === "false") return false;
    return `${field} must be a boolean.`;
  };

  if (ssl !== undefined) {
    const v = parseBool(ssl, "ssl");
    if (typeof v === "string") return { error: v, data };
    data.ssl = v;
  }
  if (enabled !== undefined) {
    const v = parseBool(enabled, "enabled");
    if (typeof v === "string") return { error: v, data };
    data.enabled = v;
  }
  if (isDownload !== undefined) {
    const v = parseBool(isDownload, "isDownload");
    if (typeof v === "string") return { error: v, data };
    data.isDownload = v;
  }
  if (isUpload !== undefined) {
    const v = parseBool(isUpload, "isUpload");
    if (typeof v === "string") return { error: v, data };
    data.isUpload = v;
  }

  return { data };
}

// ─── Usenet Providers ────────────────────────────────────────────────

/** GET /admin/config/usenet-providers — list all providers */
router.get("/usenet-providers", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const providers = await listProviders(reveal);
    res.json({ providers });
  } catch (err) {
    console.error("[admin-config] List providers error:", err);
    res.status(500).json({ error: "Failed to list providers." });
  }
});

/** POST /admin/config/usenet-providers — create a provider */
router.post("/usenet-providers", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const validation = validateProviderInput(req.body, true);
    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const d = validation.data;
    const provider = await createProvider({
      name: d.name!,
      host: d.host!,
      postHost: d.postHost,
      port: d.port,
      ssl: d.ssl,
      username: d.username!,
      password: d.password!,
      connections: d.connections,
      priority: d.priority,
      enabled: d.enabled,
      isDownload: d.isDownload,
      isUpload: d.isUpload,
    });

    console.log(`[admin-config] Provider created: ${d.name} by ${req.user?.userId}`);
    res.status(201).json({ provider });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Provider with this name already exists." });
      return;
    }
    console.error("[admin-config] Create provider error:", err);
    res.status(500).json({ error: "Failed to create provider." });
  }
});

/** GET /admin/config/usenet-providers/:id — get a single provider */
router.get("/usenet-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const provider = await getProviderById(String(req.params.id), reveal);
    if (!provider) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }
    res.json({ provider });
  } catch (err) {
    console.error("[admin-config] Get provider error:", err);
    res.status(500).json({ error: "Failed to get provider." });
  }
});

/** PUT /admin/config/usenet-providers/:id — update a provider */
router.put("/usenet-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const validation = validateProviderInput(req.body, false);
    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    if (validation.data.password !== undefined && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const provider = await updateProvider(String(req.params.id), validation.data);

    if (!provider) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }

    console.log(`[admin-config] Provider updated: ${provider.name} by ${req.user?.userId}`);
    res.json({ provider });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "Provider with this name already exists." });
      return;
    }
    console.error("[admin-config] Update provider error:", err);
    res.status(500).json({ error: "Failed to update provider." });
  }
});

/** DELETE /admin/config/usenet-providers/:id — delete a provider */
router.delete("/usenet-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const providerId = String(req.params.id);
    const deleted = await deleteProvider(providerId);
    if (!deleted) {
      res.status(404).json({ error: "Provider not found." });
      return;
    }
    console.log(`[admin-config] Provider deleted: ${providerId} by ${req.user?.userId}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("[admin-config] Delete provider error:", err);
    res.status(500).json({ error: "Failed to delete provider." });
  }
});

// ─── VPN Provider Input Validation ────────────────────────────────────

interface VpnProviderValidationResult {
  error?: string;
  data: {
    name?: string;
    configBlob?: string;
    username?: string | null;
    password?: string | null;
    enabled?: boolean;
  };
}

function validateVpnProviderInput(body: unknown, requireFields: boolean): VpnProviderValidationResult {
  const data: VpnProviderValidationResult["data"] = {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object.", data };
  }
  const { name, configBlob, username, password, enabled } = body as Record<string, unknown>;

  if (requireFields) {
    if (typeof name !== "string" || !name.trim()) return { error: "name must be a non-empty string.", data };
    if (typeof configBlob !== "string" || !configBlob.trim()) return { error: "configBlob must be a non-empty string.", data };
  }

  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) return { error: "name must be a non-empty string.", data };
    data.name = name.trim();
  }
  if (configBlob !== undefined) {
    if (typeof configBlob !== "string" || !configBlob.trim()) return { error: "configBlob must be a non-empty string.", data };
    data.configBlob = configBlob;
  }
  if (username !== undefined) {
    if (username === null || username === "") {
      data.username = null;
    } else if (typeof username === "string") {
      data.username = username.trim() || null;
    } else {
      return { error: "username must be a string or null.", data };
    }
  }
  if (password !== undefined) {
    if (password === null || password === "") {
      data.password = null;
    } else if (typeof password === "string") {
      data.password = password;
    } else {
      return { error: "password must be a string or null.", data };
    }
  }
  if (enabled !== undefined) {
    if (typeof enabled === "boolean") {
      data.enabled = enabled;
    } else if (enabled === "true") {
      data.enabled = true;
    } else if (enabled === "false") {
      data.enabled = false;
    } else {
      return { error: "enabled must be a boolean.", data };
    }
  }

  return { data };
}

// ─── VPN Providers ───────────────────────────────────────────────────

/** GET /admin/config/vpn-providers — list all VPN providers */
router.get("/vpn-providers", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const providers = await listVpnProviders(reveal);
    res.json({ providers });
  } catch (err) {
    console.error("[admin-config] List VPN providers error:", err);
    res.status(500).json({ error: "Failed to list VPN providers." });
  }
});

/** POST /admin/config/vpn-providers — create a VPN provider */
router.post("/vpn-providers", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const validation = validateVpnProviderInput(req.body, true);
    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const d = validation.data;
    const provider = await createVpnProvider({
      name: d.name!,
      configBlob: d.configBlob!,
      username: d.username,
      password: d.password,
      enabled: d.enabled,
    });

    console.log(`[admin-config] VPN Provider created: ${d.name} by ${req.user?.userId}`);
    res.status(201).json({ provider });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "VPN provider with this name already exists." });
      return;
    }
    if (err?.message?.includes("Unrecognized VPN config format")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[admin-config] Create VPN provider error:", err);
    res.status(500).json({ error: "Failed to create VPN provider." });
  }
});

/** GET /admin/config/vpn-providers/:id — get a single VPN provider */
router.get("/vpn-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const reveal = req.query.reveal === "true";
    if (reveal && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }
    const provider = await getVpnProviderById(String(req.params.id), reveal);
    if (!provider) {
      res.status(404).json({ error: "VPN provider not found." });
      return;
    }
    res.json({ provider });
  } catch (err) {
    console.error("[admin-config] Get VPN provider error:", err);
    res.status(500).json({ error: "Failed to get VPN provider." });
  }
});

/** PUT /admin/config/vpn-providers/:id — update a VPN provider */
router.put("/vpn-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const validation = validateVpnProviderInput(req.body, false);
    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const needsEncryption = validation.data.configBlob !== undefined ||
      (validation.data.username !== undefined && validation.data.username !== null) ||
      (validation.data.password !== undefined && validation.data.password !== null);
    if (needsEncryption && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const provider = await updateVpnProvider(String(req.params.id), validation.data);

    if (!provider) {
      res.status(404).json({ error: "VPN provider not found." });
      return;
    }

    console.log(`[admin-config] VPN Provider updated: ${provider.name} by ${req.user?.userId}`);
    res.json({ provider });
  } catch (err: any) {
    if (err?.code === "P2002") {
      res.status(409).json({ error: "VPN provider with this name already exists." });
      return;
    }
    if (err?.message?.includes("Unrecognized VPN config format")) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("[admin-config] Update VPN provider error:", err);
    res.status(500).json({ error: "Failed to update VPN provider." });
  }
});

/** DELETE /admin/config/vpn-providers/:id — delete a VPN provider */
router.delete("/vpn-providers/:id", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const providerId = String(req.params.id);
    const deleted = await deleteVpnProvider(providerId);
    if (!deleted) {
      res.status(404).json({ error: "VPN provider not found." });
      return;
    }
    console.log(`[admin-config] VPN Provider deleted: ${providerId} by ${req.user?.userId}`);
    res.json({ deleted: true });
  } catch (err) {
    console.error("[admin-config] Delete VPN provider error:", err);
    res.status(500).json({ error: "Failed to delete VPN provider." });
  }
});

// ─── VPS Events ───────────────────────────────────────────────────────

/** GET /admin/config/vps-events — list VPS events with optional filters */
router.get("/vps-events", requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    // ── Validate limit ────────────────────────────────────────────────
    const rawLimit = req.query.limit;
    let limit = 50;
    if (rawLimit !== undefined) {
      if (Array.isArray(rawLimit) || typeof rawLimit !== "string") {
        res.status(400).json({ error: "limit must be a single string value." });
        return;
      }
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        res.status(400).json({ error: "limit must be an integer between 1 and 200." });
        return;
      }
      limit = parsed;
    }

    // ── Validate offset ───────────────────────────────────────────────
    const rawOffset = req.query.offset;
    let offset = 0;
    const MAX_OFFSET = 1_000_000;
    if (rawOffset !== undefined) {
      if (Array.isArray(rawOffset) || typeof rawOffset !== "string") {
        res.status(400).json({ error: "offset must be a single string value." });
        return;
      }
      const parsed = Number(rawOffset);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_OFFSET) {
        res.status(400).json({ error: `offset must be an integer between 0 and ${MAX_OFFSET}.` });
        return;
      }
      offset = parsed;
    }

    // ── Validate enum filters ─────────────────────────────────────────
    const jobType = req.query.jobType as string | undefined;
    if (jobType !== undefined && !["download", "upload"].includes(jobType)) {
      res.status(400).json({ error: 'jobType must be "download" or "upload".' });
      return;
    }

    const VALID_SEVERITIES = ["info", "warning", "error", "critical"] as const;
    const severity = req.query.severity as string | undefined;
    if (severity !== undefined && !(VALID_SEVERITIES as readonly string[]).includes(severity)) {
      res.status(400).json({ error: `severity must be one of: ${VALID_SEVERITIES.join(", ")}.` });
      return;
    }

    const VALID_EVENT_TYPES = ["routing_anomaly", "routing_verified", "vpn_down", "vpn_reconnect", "vpn_reconnect_failed", "watchdog", "bootstrap", "bootstrap_complete"] as const;
    const rawEventType = req.query.eventType;
    let eventType: string | undefined;
    if (rawEventType !== undefined) {
      if (typeof rawEventType !== "string" || !rawEventType.trim()) {
        res.status(400).json({ error: "eventType must be a non-empty string." });
        return;
      }
      if (!(VALID_EVENT_TYPES as readonly string[]).includes(rawEventType)) {
        res.status(400).json({ error: `eventType must be one of: ${VALID_EVENT_TYPES.join(", ")}.` });
        return;
      }
      eventType = rawEventType;
    }

    const where: Prisma.VpsEventWhereInput = {};
    if (jobType) where.jobType = jobType;
    if (eventType) where.eventType = eventType;
    if (severity) where.severity = severity;

    const [events, total] = await Promise.all([
      prisma.vpsEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          downloadJob: { select: { id: true, status: true, hetznerServerId: true } },
          uploadJob: { select: { id: true, status: true, hetznerServerId: true } },
        },
      }),
      prisma.vpsEvent.count({ where }),
    ]);

    res.json({ events, total, limit, offset });
  } catch (err) {
    console.error("[admin-config] List VPS events error:", err);
    res.status(500).json({ error: "Failed to list VPS events." });
  }
});

// ─── VPS Status Dashboard ─────────────────────────────────────────────

/** GET /admin/config/vps-status — active VPS counts, limits, and queued jobs */
router.get("/vps-status", requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [counts, limits, queuedDownloads, queuedUploads] = await Promise.all([
      getActiveVpsCounts(),
      getVpsLimits(),
      prisma.downloadJob.count({ where: { status: "queued", hetznerServerId: null } }),
      prisma.uploadJob.count({ where: { status: "queued", hetznerServerId: null } }),
    ]);

    res.json({
      counts,
      limits,
      queued: {
        downloads: queuedDownloads,
        uploads: queuedUploads,
        total: queuedDownloads + queuedUploads,
      },
    });
  } catch (err) {
    console.error("[admin-config] VPS status error:", err);
    res.status(500).json({ error: "Failed to get VPS status." });
  }
});

export default router;
