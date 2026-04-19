/**
 * Admin Config Routes — CRUD for the centralized config store.
 *
 * All routes require auth. Secrets are masked unless ?reveal=true.
 */

import { Router, type Response } from "express";
import { requireAuth, requireAdmin, requireServiceToken, type AuthRequest } from "../middleware/auth.js";
import { isEncryptionConfigured } from "../lib/crypto.js";
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
    const { name, host, postHost, port, ssl, username, password, connections, priority, enabled, isDownload, isUpload } = req.body;

    if (!name || !host || !username || !password) {
      res.status(400).json({ error: "name, host, username, and password are required." });
      return;
    }

    if (!isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const provider = await createProvider({
      name, host, postHost, port, ssl, username, password, connections, priority, enabled, isDownload, isUpload,
    });

    console.log(`[admin-config] Provider created: ${name} by ${req.user?.userId}`);
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
    const { name, host, postHost, port, ssl, username, password, connections, priority, enabled, isDownload, isUpload } = req.body;

    if (password !== undefined && !isEncryptionConfigured()) {
      res.status(503).json({ error: "Encryption not configured." });
      return;
    }

    const provider = await updateProvider(String(req.params.id), {
      name, host, postHost, port, ssl, username, password, connections, priority, enabled, isDownload, isUpload,
    });

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

export default router;
