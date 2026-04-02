import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import {
  isS3Configured,
  listFiles,
  generatePresignedUrl,
  generatePresignedUploadUrl,
  deleteFile,
  getFileMetadata,
  fileExists,
  EXPIRY_PRESETS,
  MAX_PRESIGNED_EXPIRY_SECONDS,
} from "../lib/s3.js";
import { getStorageUsage, getCleanupCandidates, runCleanupCycle } from "../lib/s3-lifecycle.js";

const router = Router();

router.use(requireAuth);

/**
 * Middleware: check S3 is configured before any storage operation.
 */
router.use((_req: AuthRequest, res: Response, next) => {
  if (!isS3Configured()) {
    res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
    return;
  }
  next();
});

/**
 * Safely decode a URL-encoded key parameter.
 * Returns null if the key contains invalid percent-escapes.
 */
function decodeKey(raw: string | string[]): string | null {
  try {
    return decodeURIComponent(String(raw));
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
}

// GET /storage/files — list files in the bucket
router.get("/files", async (req: AuthRequest, res: Response) => {
  try {
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : undefined;
    const continuationToken = typeof req.query.cursor === "string" ? req.query.cursor : undefined;

    // Validate limit parameter
    let maxKeys = 100;
    if (typeof req.query.limit === "string") {
      const parsed = parseInt(req.query.limit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 1000) {
        res.status(400).json({ error: "limit muss eine Zahl zwischen 1 und 1000 sein." });
        return;
      }
      maxKeys = parsed;
    }

    const result = await listFiles(prefix, maxKeys, continuationToken);

    res.json(result);
  } catch (err) {
    console.error("[storage] List files error:", err);
    res.status(500).json({ error: "Fehler beim Auflisten der Dateien." });
  }
});

// GET /storage/files/:key/url — generate presigned download URL
// Key is URL-encoded (e.g. "abc123%2Fabc123.mkv" for "abc123/abc123.mkv")
router.get("/files/:key/url", async (req: AuthRequest, res: Response) => {
  try {
    const key = decodeKey(req.params.key);
    if (key === null) {
      res.status(400).json({ error: "Ungültiger Key (fehlerhafte URL-Kodierung)." });
      return;
    }

    const expiresParam = typeof req.query.expires === "string" ? req.query.expires : "7d";

    // Resolve expiry: either a preset name or raw seconds
    let expiresIn: number;
    if (Object.hasOwn(EXPIRY_PRESETS, expiresParam)) {
      expiresIn = EXPIRY_PRESETS[expiresParam];
    } else {
      expiresIn = parseInt(expiresParam, 10);
      if (isNaN(expiresIn) || expiresIn < 60) {
        res.status(400).json({ error: "Ungültiger expires-Wert. Verwende 1h, 1d, 3d, 7d oder Sekunden (min 60)." });
        return;
      }
    }

    // Cap to max presigned URL expiry
    const cappedExpires = Math.min(expiresIn, MAX_PRESIGNED_EXPIRY_SECONDS);

    // Verify file exists before generating URL
    try {
      await getFileMetadata(key);
    } catch (err: any) {
      if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
        res.status(404).json({ error: "Datei nicht gefunden." });
        return;
      }
      throw err;
    }

    const url = await generatePresignedUrl(key, cappedExpires);

    const expiresAt = new Date(Date.now() + cappedExpires * 1000).toISOString();

    res.json({
      url,
      key,
      expiresIn: cappedExpires,
      expiresAt,
    });
  } catch (err) {
    console.error("[storage] Generate URL error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Download-Links." });
  }
});

// GET /storage/files/:key/meta — get file metadata
router.get("/files/:key/meta", async (req: AuthRequest, res: Response) => {
  try {
    const key = decodeKey(req.params.key);
    if (key === null) {
      res.status(400).json({ error: "Ungültiger Key (fehlerhafte URL-Kodierung)." });
      return;
    }

    const meta = await getFileMetadata(key);

    res.json(meta);
  } catch (err: any) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: "Datei nicht gefunden." });
      return;
    }
    console.error("[storage] Get metadata error:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Metadaten." });
  }
});

// DELETE /storage/files/:key — delete a file
// Note: S3 delete is idempotent — succeeds even if key doesn't exist.
// We verify existence first and return 404 if the key is unknown.
router.delete("/files/:key", async (req: AuthRequest, res: Response) => {
  try {
    const key = decodeKey(req.params.key);
    if (key === null) {
      res.status(400).json({ error: "Ungültiger Key (fehlerhafte URL-Kodierung)." });
      return;
    }

    // Verify file exists before deleting (S3 delete always succeeds)
    const exists = await fileExists(key);
    if (!exists) {
      res.status(404).json({ error: "Datei nicht gefunden." });
      return;
    }

    await deleteFile(key);

    console.log(`[storage] Deleted by user ${req.user?.userId}: ${key}`);

    res.json({ success: true, key });
  } catch (err) {
    console.error("[storage] Delete error:", err);
    res.status(500).json({ error: "Fehler beim Löschen der Datei." });
  }
});

// POST /storage/upload-url — generate presigned upload URL
router.post("/upload-url", async (req: AuthRequest, res: Response) => {
  try {
    const { key, contentType, expiresIn: rawExpiry } = req.body;

    if (!key || typeof key !== "string") {
      res.status(400).json({ error: "key ist erforderlich (string)." });
      return;
    }

    // Validate expiresIn: must be a positive integer >= 60
    let expiresIn = 3600; // default 1 hour
    if (rawExpiry !== undefined) {
      if (typeof rawExpiry !== "number" || !Number.isInteger(rawExpiry) || rawExpiry < 60) {
        res.status(400).json({ error: "expiresIn muss eine positive Ganzzahl >= 60 sein (Sekunden)." });
        return;
      }
      expiresIn = Math.min(rawExpiry, 3600);
    }

    const url = await generatePresignedUploadUrl(key, contentType, expiresIn);

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    console.log(`[storage] Upload URL generated by user ${req.user?.userId}: ${key}`);

    res.json({
      url,
      key,
      expiresIn,
      expiresAt,
    });
  } catch (err) {
    console.error("[storage] Generate upload URL error:", err);
    res.status(500).json({ error: "Fehler beim Erstellen der Upload-URL." });
  }
});

// ── S3 Lifecycle Endpoints ───────────────────────────────────

// GET /storage/usage — current S3 bucket usage
router.get("/usage", async (_req: AuthRequest, res: Response) => {
  try {
    const usage = await getStorageUsage();
    res.json(usage);
  } catch (err) {
    console.error("[storage] Usage error:", err);
    res.status(500).json({ error: "Fehler beim Berechnen der Speichernutzung." });
  }
});

// GET /storage/cleanup-candidates — LRU-sorted files for potential cleanup
router.get("/cleanup-candidates", async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit) || "20", 10) || 20, 1), 100);
    const candidates = await getCleanupCandidates(limit);
    res.json({ candidates });
  } catch (err) {
    console.error("[storage] Cleanup candidates error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Cleanup-Kandidaten." });
  }
});

// POST /storage/cleanup — run full cleanup cycle (mark + execute)
router.post("/cleanup", async (_req: AuthRequest, res: Response) => {
  try {
    const result = await runCleanupCycle();
    res.json(result);
  } catch (err) {
    console.error("[storage] Cleanup error:", err);
    res.status(500).json({ error: "Fehler beim Ausführen des Cleanup-Zyklus." });
  }
});

export default router;
