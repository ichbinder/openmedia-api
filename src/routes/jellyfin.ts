import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import prisma from "../lib/prisma.js";
import { generateApiToken, hashToken, MAX_TOKENS_PER_USER } from "../lib/api-token.js";
import {
  buildJellyfinManifest,
  buildPersonalizedPluginZip,
} from "../lib/jellyfin-manifest.js";

const router = Router();

// Token-via-query fallback for /stream/:hash only.
//
// STRM files (which Jellyfin/Swiftfin opens as plain URLs) cannot send custom
// Authorization headers, so we accept ?token=<JWT|om_apiToken> as a fallback.
// We promote the query token into the Authorization header and *delete* the
// query param so downstream logging and error rendering can never reflect it.
//
// Scope-limited to /stream/:hash on purpose — /library has no STRM use case
// and a smaller token-leak surface is better.
export const STREAM_PATH_RE = /^\/stream\/[^/]+\/?$/;
export const MIN_TOKEN_LEN = 20; // shortest plausible JWT or om_-token
export const MAX_TOKEN_LEN = 4096; // generous JWT upper bound; protects logs/headers

// Exported for direct unit testing — the named export ensures regression tests
// can assert token redaction independently of the surrounding route.
export function streamTokenFallback(req: Request, _res: Response, next: NextFunction): void {
  if (!STREAM_PATH_RE.test(req.path)) return next();

  const raw = req.query.token;

  // ALWAYS strip the token from req.query AND req.url FIRST — before any early
  // return AND regardless of whether `raw` is a string, an array (multi-value
  // query like `?token=a&token=b`), or some other shape. Otherwise a request
  // that already has an Authorization header, a multi-value token, or a token
  // outside the acceptable length range would leave `token=<value>` in req.url
  // where downstream access loggers and error handlers can see it.
  delete (req.query as Record<string, unknown>).token;
  if (req.url.includes("token=")) {
    const [pathPart, queryPart] = req.url.split("?", 2);
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      params.delete("token");
      const filtered = params.toString();
      req.url = filtered ? `${pathPart}?${filtered}` : pathPart;
    }
  }

  if (req.headers.authorization) return next();
  if (typeof raw !== "string") return next();
  if (raw.length < MIN_TOKEN_LEN || raw.length > MAX_TOKEN_LEN) return next();

  req.headers.authorization = `Bearer ${raw}`;

  // Mark how this request was authenticated for the stream-handler log line.
  (req as AuthRequest & { authSource?: "query" | "header" }).authSource = "query";
  next();
}

router.use(streamTokenFallback);

// ---------------------------------------------------------------------------
// Plugin Setup + Repository Manifest
//
// These endpoints sit BEFORE the global requireAuth middleware below so each
// can manage its own auth:
//   - POST /plugin/setup  → requireAuth (user JWT or om_-token)
//   - GET  /repo/manifest.json → public, validates ?t=om_xxx itself
// ---------------------------------------------------------------------------

const TOKEN_EXPIRY_DAYS = 365; // Plugin-Tokens leben lange — User widerruft per Profil.
const SETUP_RATE_LIMIT_MS = 60_000; // max 1 Setup pro User pro Minute

// In-memory rate limit. Process-local is fine — accidental burst from one user
// is the only concern; coordinated attacks across instances aren't realistic
// for this auth-gated endpoint.
const lastSetupAt = new Map<string, number>();

/** Reset the in-memory rate-limit state. Test-only helper. */
export function _resetJellyfinSetupRateLimit(): void {
  lastSetupAt.clear();
}

function formatDateDDMMYYYY(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function resolveApiBaseUrl(req: Request): string {
  const explicit = process.env.API_BASE_URL?.trim();
  return explicit
    ? explicit.replace(/\/$/, "")
    : `${req.protocol}://${req.get("host")}`;
}

function buildManifestUrl(req: Request, plaintextToken: string): string {
  return `${resolveApiBaseUrl(req)}/jellyfin/repo/manifest.json?t=${encodeURIComponent(plaintextToken)}`;
}

/**
 * Token-Validierung fuer die public Jellyfin-Endpoints (manifest + plugin.zip).
 * Strippt den `t=`-Query-Parameter aus req.url damit er nicht in Access-Logs
 * landet. Bei Fehler wird die Response selbst gesendet und `null` zurueck.
 */
async function validatePluginToken(
  req: Request,
  res: Response,
): Promise<{ userId: string; tokenPrefix: string; tokenId: string; plaintext: string } | null> {
  const rawToken = typeof req.query.t === "string" ? req.query.t : "";

  if (req.url.includes("t=")) {
    const [pathPart, queryPart] = req.url.split("?", 2);
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      params.delete("t");
      const filtered = params.toString();
      req.url = filtered ? `${pathPart}?${filtered}` : pathPart;
    }
  }
  delete (req.query as Record<string, unknown>).t;

  if (!rawToken || !rawToken.startsWith("om_") || rawToken.length < 20 || rawToken.length > 4096) {
    res.status(401).json({ error: "Token fehlt oder ungültig." });
    return null;
  }

  const tokenHashValue = hashToken(rawToken);
  const tokenRow = await prisma.apiToken.findUnique({
    where: { tokenHash: tokenHashValue },
    select: {
      id: true,
      userId: true,
      tokenPrefix: true,
      purpose: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!tokenRow) {
    console.warn("[jellyfin] token: unknown");
    res.status(401).json({ error: "Token ungültig." });
    return null;
  }
  if (tokenRow.purpose !== "jellyfin-plugin") {
    console.warn(`[jellyfin] token: wrong purpose token=${tokenRow.tokenPrefix}...`);
    res.status(401).json({ error: "Token nicht für Jellyfin-Plugin freigegeben." });
    return null;
  }
  if (tokenRow.revokedAt !== null) {
    console.warn(`[jellyfin] token: revoked token=${tokenRow.tokenPrefix}...`);
    res.status(401).json({ error: "Token wurde widerrufen." });
    return null;
  }
  if (tokenRow.expiresAt.getTime() < Date.now()) {
    console.warn(`[jellyfin] token: expired token=${tokenRow.tokenPrefix}...`);
    res.status(401).json({ error: "Token ist abgelaufen." });
    return null;
  }

  // Fire-and-forget lastUsedAt — never blocks the response.
  prisma.apiToken
    .update({ where: { id: tokenRow.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => console.error(`[jellyfin] lastUsedAt update failed: ${err?.message || err}`));

  return {
    userId: tokenRow.userId,
    tokenPrefix: tokenRow.tokenPrefix,
    tokenId: tokenRow.id,
    plaintext: rawToken,
  };
}

/**
 * POST /jellyfin/plugin/setup
 *
 * Creates a long-lived om_-token with purpose='jellyfin-plugin' and returns a
 * personalised Jellyfin repository URL. The plaintext token is shown ONCE in
 * the manifestUrl query param — it is not stored anywhere else in the response.
 */
router.post("/plugin/setup", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Rate limit: 1 setup per user per minute.
    const now = Date.now();
    const last = lastSetupAt.get(userId) ?? 0;
    if (now - last < SETUP_RATE_LIMIT_MS) {
      const retryAfter = Math.ceil((SETUP_RATE_LIMIT_MS - (now - last)) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Bitte warte kurz vor dem nächsten Setup." });
      return;
    }

    // Per-user active token cap also applies to plugin tokens.
    const activeCount = await prisma.apiToken.count({
      where: { userId, revokedAt: null },
    });
    if (activeCount >= MAX_TOKENS_PER_USER) {
      res.status(400).json({
        error: `Maximal ${MAX_TOKENS_PER_USER} aktive Tokens erlaubt. Bitte einen bestehenden widerrufen.`,
      });
      return;
    }

    const { plaintext, hash, prefix } = generateApiToken();
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const name = `Jellyfin Plugin (${formatDateDDMMYYYY(new Date())})`;

    const created = await prisma.apiToken.create({
      data: {
        userId,
        tokenHash: hash,
        tokenPrefix: prefix,
        name,
        purpose: "jellyfin-plugin",
        expiresAt,
      },
    });

    lastSetupAt.set(userId, now);

    console.log(
      `[jellyfin] plugin setup: user=${userId.slice(0, 8)}... token=${prefix}... expires=${expiresAt.toISOString().slice(0, 10)}`,
    );

    res.status(201).json({
      manifestUrl: buildManifestUrl(req, plaintext),
      tokenId: created.id,
      name: created.name,
      prefix: created.tokenPrefix,
      expiresAt: created.expiresAt,
    });
  } catch (err) {
    console.error("[jellyfin] plugin setup error:", err);
    res.status(500).json({ error: "Plugin-Setup fehlgeschlagen." });
  }
});

/**
 * GET /jellyfin/repo/manifest.json?t=om_xxx
 *
 * Public endpoint. Validates the token (must be active, not revoked, not
 * expired, purpose='jellyfin-plugin') and returns a Jellyfin-conformant
 * repository manifest. Manifest fields kommen aus der `meta.json` im upstream
 * Plugin-ZIP (dist-Branch). `sourceUrl` zeigt auf `/jellyfin/plugin.zip?t=om_xxx`,
 * `checksum` ist der MD5 der User-spezifischen ZIP.
 */
router.get("/repo/manifest.json", async (req: Request, res: Response) => {
  try {
    const auth = await validatePluginToken(req, res);
    if (!auth) return;

    const manifest = await buildJellyfinManifest({
      apiBaseUrl: resolveApiBaseUrl(req),
      apiToken: auth.plaintext,
    });

    console.log(
      `[jellyfin] manifest: user=${auth.userId.slice(0, 8)}... token=${auth.tokenPrefix}... entries=${manifest.length} version=${manifest[0]?.versions[0]?.version || "none"}`,
    );

    // Jellyfin checks the URL on every refresh; tell caches to leave it alone.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.json(manifest);
  } catch (err) {
    console.error("[jellyfin] manifest error:", err);
    res.status(500).json({ error: "Manifest konnte nicht erzeugt werden." });
  }
});

/**
 * GET /jellyfin/plugin.zip?t=om_xxx
 *
 * Liefert das User-spezifische Plugin-ZIP aus: upstream-ZIP (cached, vom
 * dist-Branch des Plugin-Repos) + injizierte `bootstrap.json` mit
 * `{apiUrl, apiToken}`. Jellyfin verifiziert den MD5 gegen den im Manifest
 * deklarierten Wert — Build muss deterministisch sein (siehe
 * jellyfin-manifest.ts buildPersonalizedPluginZip).
 */
router.get("/plugin.zip", async (req: Request, res: Response) => {
  try {
    const auth = await validatePluginToken(req, res);
    if (!auth) return;

    const { buffer, md5, version } = await buildPersonalizedPluginZip({
      apiBaseUrl: resolveApiBaseUrl(req),
      apiToken: auth.plaintext,
    });

    console.log(
      `[jellyfin] plugin.zip: user=${auth.userId.slice(0, 8)}... token=${auth.tokenPrefix}... version=${version} md5=${md5} bytes=${buffer.length}`,
    );

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Content-Disposition", "attachment; filename=\"openmedia.zip\"");
    // Schwacher ETag — Jellyfin re-fetcht ohnehin per Manifest-Polling.
    res.setHeader("ETag", `"${md5}"`);
    res.status(200).end(buffer);
  } catch (err) {
    console.error("[jellyfin] plugin.zip error:", err);
    if (!res.headersSent) {
      res.status(502).json({ error: "Plugin-ZIP konnte nicht ausgeliefert werden." });
    }
  }
});

router.use(requireAuth);

// Presigned-URL TTL for Jellyfin stream requests. Short on purpose — the plugin
// always fetches a fresh URL just before play, so a long TTL adds nothing.
const STREAM_URL_TTL_SECONDS = 60 * 60; // 1h

function mimeTypeFor(opts: { hasStreamKey: boolean; fileExtension: string | null }): string {
  if (opts.hasStreamKey) return "video/mp4";
  const ext = (opts.fileExtension || "").toLowerCase();
  if (ext === ".mp4" || ext === "mp4") return "video/mp4";
  if (ext === ".mkv" || ext === "mkv") return "video/x-matroska";
  return "application/octet-stream";
}

// GET /jellyfin/library/version — lightweight change-detection endpoint.
//
// Returns a stable ETag derived from (hash, s3-presence) of all UserLibrary
// rows for the caller. The Jellyfin plugin polls this every ~15s and only
// triggers a full /library fetch + sync when the ETag changes.
//
// Cheap on purpose: only `hash` + `s3Key` are selected, sorted in-DB by hash
// for stable input order, then sha256-hashed in-process. No JSON serialization
// of full items, no joins beyond what's strictly needed.
//
// Cache-Control: no-store — the plugin must always see the freshest value.
router.get("/library/version", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const rows = await prisma.userLibrary.findMany({
      where: {
        userId,
        removedAt: null,
        nzbFile: { s3Key: { not: null } },
      },
      select: {
        nzbFile: { select: { hash: true, s3Key: true } },
      },
      orderBy: { nzbFile: { hash: "asc" } },
    });

    // Filter mirrors /library (s3Key presence already enforced via where).
    // s3-flag included so a re-download (s3Key going null → set) flips ETag
    // even when the hash set is unchanged.
    const fingerprint = rows.map((r) => `${r.nzbFile.hash}:${r.nzbFile.s3Key ? 1 : 0}`).join("\n");
    const etag = createHash("sha256").update(fingerprint).digest("hex");

    res.setHeader("Cache-Control", "no-store");
    res.json({ etag, count: rows.length });
  } catch (err) {
    console.error("[jellyfin] library/version error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Library-Version." });
  }
});

// GET /jellyfin/library — flat list of the authenticated user's library items
// that are actually downloaded (have s3Key). One row per UserLibrary entry.
//
// Shape is intentionally lean — the Jellyfin plugin only needs enough to
// create BaseItems and let Jellyfin's TMDB provider fill in posters/metadata.
router.get("/library", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const rows = await prisma.userLibrary.findMany({
      where: {
        userId,
        removedAt: null,
        nzbFile: { s3Key: { not: null } },
      },
      include: {
        nzbFile: {
          select: {
            hash: true,
            fileSize: true,
            duration: true,
            resolution: true,
            qualityTier: true,
            movie: { select: { tmdbId: true, titleDe: true, titleEn: true, year: true } },
          },
        },
      },
      orderBy: { addedAt: "desc" },
    });

    const items = rows
      .filter((row) => row.nzbFile.movie !== null && row.nzbFile.movie.tmdbId !== null)
      .map((row) => {
        const movie = row.nzbFile.movie!;
        return {
          hash: row.nzbFile.hash,
          tmdbId: movie.tmdbId,
          title: movie.titleDe || movie.titleEn,
          year: movie.year,
          // BigInt → string for safe JSON serialization. Plugin parses as needed.
          fileSize: row.nzbFile.fileSize !== null ? row.nzbFile.fileSize.toString() : null,
          duration: row.nzbFile.duration,
          resolution: row.nzbFile.qualityTier || row.nzbFile.resolution,
        };
      });

    console.log(`[jellyfin] library: user=${userId.slice(0, 8)}... count=${items.length}`);
    res.json({ items });
  } catch (err) {
    console.error("[jellyfin] library error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Jellyfin-Library." });
  }
});

// GET /jellyfin/stream/:hash — 302 redirect to a fresh S3 presigned URL.
//
// Architecture decision: STRM → API → 302 → S3-Presigned (D-jellyfin-strm-302).
// The plugin/Swiftfin follows the redirect and Direct-Plays from S3.
//
// We:
//   1. Resolve NzbFile by hash
//   2. Confirm the caller has this hash in their active library (otherwise 404 —
//      never leak whether the hash exists for other users)
//   3. Pick s3StreamKey if present (browser-friendly MP4 stereo), else s3Key
//   4. HEAD-check S3 (FILE_GONE pattern — reset DB on 404, 502 on transient)
//   5. Bump lastAccessedAt (LRU tracking) fire-and-forget
//   6. 302 Redirect to fresh 1h presigned URL (Cache-Control: no-store)
router.get("/stream/:hash", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const hash = String(req.params.hash);

    const nzbFile = await prisma.nzbFile.findUnique({
      where: { hash },
      select: {
        id: true,
        hash: true,
        s3Key: true,
        s3StreamKey: true,
        s3Bucket: true,
        fileExtension: true,
      },
    });

    if (!nzbFile) {
      res.status(404).json({ error: "Nicht gefunden." });
      return;
    }

    // Access check — user must have this hash in their library, otherwise 404
    // (not 403, to avoid revealing existence of other users' content).
    const libraryEntry = await prisma.userLibrary.findFirst({
      where: { userId, nzbFileId: nzbFile.id, removedAt: null },
      select: { id: true },
    });
    if (!libraryEntry) {
      res.status(404).json({ error: "Nicht gefunden." });
      return;
    }

    // Prefer the browser-friendly stream key (stereo MP4) — Apple TV/Swiftfin
    // can direct-play MKV, but MP4-stereo is the safest cross-client baseline.
    const streamKey = nzbFile.s3StreamKey || nzbFile.s3Key;
    if (!streamKey) {
      res.status(422).json({ error: "Film wurde noch nicht heruntergeladen." });
      return;
    }

    const { isS3Configured, generatePresignedUrl, getFileMetadata } = await import("../lib/s3.js");

    if (!isS3Configured()) {
      res.status(503).json({ error: "Object Storage ist nicht konfiguriert." });
      return;
    }

    // Verify the file actually exists in S3 before generating a presigned URL.
    // Mirrors the /downloads/jobs/:id/link FILE_GONE pattern.
    try {
      await getFileMetadata(streamKey, nzbFile.s3Bucket || undefined);
    } catch (s3Err: unknown) {
      const errObj = s3Err as { $metadata?: { httpStatusCode?: number }; name?: string; message?: string };
      const statusCode = errObj?.$metadata?.httpStatusCode || errObj?.name;
      if (statusCode === 404 || statusCode === "NotFound" || errObj?.name === "NotFound") {
        await prisma.nzbFile.update({
          where: { id: nzbFile.id },
          data: {
            s3Key: null,
            s3StreamKey: null,
            s3Bucket: null,
            fileExtension: null,
            downloadedAt: null,
            scheduledDeletionAt: null,
          },
        });
        console.warn(`[jellyfin] stream FILE_GONE: hash=${hash.slice(0, 12)}... — DB reset`);
        res.status(410).json({
          error: "Datei ist nicht mehr verfügbar. Bitte erneut herunterladen.",
          code: "FILE_GONE",
        });
        return;
      }
      console.error(`[jellyfin] stream S3 HEAD failed: hash=${hash.slice(0, 12)}...`, errObj?.message || s3Err);
      res.status(502).json({ error: "S3-Verbindung fehlgeschlagen. Bitte erneut versuchen." });
      return;
    }

    // LRU tracking — fire-and-forget so it never blocks the response.
    prisma.nzbFile
      .update({ where: { id: nzbFile.id }, data: { lastAccessedAt: new Date() } })
      .catch((err) => console.error(`[jellyfin] lastAccessedAt update failed: ${err?.message || err}`));

    const mimeType = mimeTypeFor({
      hasStreamKey: !!nzbFile.s3StreamKey,
      fileExtension: nzbFile.fileExtension,
    });
    const url = await generatePresignedUrl(streamKey, STREAM_URL_TTL_SECONDS, {
      bucket: nzbFile.s3Bucket || undefined,
      responseContentType: mimeType,
    });

    const authSource = (req as AuthRequest & { authSource?: "query" | "header" }).authSource || "header";
    console.log(
      `[jellyfin] stream: user=${userId.slice(0, 8)}... hash=${hash.slice(0, 12)}... mime=${mimeType} auth=${authSource} → 302`,
    );

    // 302 redirect — clients (Swiftfin/Jellyfin plugin) follow to S3 for Direct-Play.
    // no-store: each play resolves a fresh URL so TTL stays honest.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, url);
  } catch (err) {
    console.error("[jellyfin] stream error:", err);
    res.status(500).json({ error: "Fehler beim Erzeugen des Stream-Links." });
  }
});

export default router;
