import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { isEncryptionConfigured } from "../lib/crypto.js";
import { setConfig, getConfig, deleteConfig, listConfigKeys } from "../lib/config-store.js";

const router = Router();

router.use(requireAuth);

/** Middleware: check encryption is configured. */
router.use((_req: AuthRequest, res: Response, next) => {
  if (!isEncryptionConfigured()) {
    res.status(503).json({ error: "Verschlüsselung ist nicht konfiguriert (ENCRYPTION_MASTER_KEY fehlt)." });
    return;
  }
  next();
});

// GET /config/keys — list all config keys (no values)
router.get("/keys", async (_req: AuthRequest, res: Response) => {
  try {
    const keys = await listConfigKeys();
    res.json({ keys });
  } catch (err) {
    console.error("[config] List keys error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Konfigurationsschlüssel." });
  }
});

// GET /config/:key — get decrypted config value
router.get("/:key", async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.key);
    const value = await getConfig(key);

    if (value === null) {
      res.status(404).json({ error: `Konfiguration '${key}' nicht gefunden.` });
      return;
    }

    // Never log the value
    console.log(`[config] Read: ${key} by user ${req.user?.userId}`);

    res.json({ key, value });
  } catch (err: any) {
    if (err.message?.includes("Entschlüsselung fehlgeschlagen")) {
      res.status(500).json({ error: err.message });
      return;
    }
    console.error("[config] Get error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Konfiguration." });
  }
});

// PUT /config/:key — set encrypted config value
router.put("/:key", async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.key);
    const { value } = req.body;

    if (value === undefined || typeof value !== "string") {
      res.status(400).json({ error: "value ist erforderlich (string)." });
      return;
    }

    if (value.length > 10000) {
      res.status(400).json({ error: "value darf maximal 10.000 Zeichen lang sein." });
      return;
    }

    await setConfig(key, value);

    // Never log the value
    console.log(`[config] Set: ${key} by user ${req.user?.userId}`);

    res.json({ key, saved: true });
  } catch (err) {
    console.error("[config] Set error:", err);
    res.status(500).json({ error: "Fehler beim Speichern der Konfiguration." });
  }
});

// DELETE /config/:key — delete config
router.delete("/:key", async (req: AuthRequest, res: Response) => {
  try {
    const key = String(req.params.key);
    const deleted = await deleteConfig(key);

    if (!deleted) {
      res.status(404).json({ error: `Konfiguration '${key}' nicht gefunden.` });
      return;
    }

    console.log(`[config] Deleted: ${key} by user ${req.user?.userId}`);

    res.json({ key, deleted: true });
  } catch (err) {
    console.error("[config] Delete error:", err);
    res.status(500).json({ error: "Fehler beim Löschen der Konfiguration." });
  }
});

export default router;
