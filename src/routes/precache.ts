import { Router, type Response, type NextFunction } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { isApiToken, hashToken } from "../lib/api-token.js";
import prisma from "../lib/prisma.js";

const router = Router();

// ─── State Machine ────────────────────────────────────────────────────────
// queued → downloading
// downloading → done | failed | downloading (progress updates)
// failed → queued (reset / retry)
// done → queued (re-precache)

const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  queued: new Set(["downloading"]),
  downloading: new Set(["done", "failed", "downloading"]),
  failed: new Set(["queued"]),
  done: new Set(["queued", "release_requested"]),
  release_requested: new Set(["released"]),
  released: new Set([]),
};

export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

// ─── Plugin-Token Middleware ───────────────────────────────────────────────
// Validates Bearer om_-token with purpose='jellyfin-plugin'.
// Sets req.user.userId from the token's owner.

interface PluginAuthRequest extends AuthRequest {
  pluginTokenId?: string;
}

async function requirePluginToken(
  req: PluginAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token || !isApiToken(token)) {
    res.status(401).json({ error: "Plugin-Token erforderlich." });
    return;
  }

  try {
    const tokenHash = hashToken(token);
    const tokenRow = await prisma.apiToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        purpose: true,
        revokedAt: true,
        expiresAt: true,
        tokenPrefix: true,
        user: { select: { email: true } },
      },
    });

    if (!tokenRow) {
      res.status(401).json({ error: "Ungültiger Plugin-Token." });
      return;
    }

    if (tokenRow.purpose !== "jellyfin-plugin") {
      res.status(401).json({ error: "Token nicht für Plugin-Zugriff freigegeben." });
      return;
    }

    if (tokenRow.revokedAt) {
      res.status(401).json({ error: "Plugin-Token wurde widerrufen." });
      return;
    }

    if (tokenRow.expiresAt < new Date()) {
      res.status(401).json({ error: "Plugin-Token ist abgelaufen." });
      return;
    }

    req.user = { userId: tokenRow.userId, email: tokenRow.user.email };
    req.pluginTokenId = tokenRow.id;

    // Fire-and-forget lastUsedAt update
    prisma.apiToken
      .update({ where: { id: tokenRow.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    next();
  } catch (err) {
    console.error("[precache] plugin token auth error:", err);
    res.status(500).json({ error: "Token-Validierung fehlgeschlagen." });
  }
}

// ─── Route Ordering Note ──────────────────────────────────────────────────
// /precache/queue and /precache/release-queue MUST be registered before
// /precache/:hash — otherwise Express matches "queue"/"release-queue" as
// a :hash parameter.

// ─── (c) GET /precache/queue — Plugin fetches pending items ──────────────
// Returns Array<{hash, userId, requestedAt}> ordered by requestedAt ASC LIMIT 50.

router.get("/precache/queue", requirePluginToken, async (req: PluginAuthRequest, res: Response) => {
  try {
    const rows = await prisma.precacheRequest.findMany({
      where: { state: "queued" },
      orderBy: { requestedAt: "asc" },
      take: 50,
      select: { hash: true, userId: true, requestedAt: true },
    });

    console.log("precache:queue_polled", {
      pluginInstallId: req.pluginTokenId?.slice(0, 8),
      returnedCount: rows.length,
    });

    res.json(rows);
  } catch (err) {
    console.error("[precache] queue error:", err);
    res.status(500).json({ error: "Queue konnte nicht geladen werden." });
  }
});

// ─── GET /precache/release-queue — Plugin fetches release_requested items ─
// Returns Array<{hash, userId, lastEventAt}> for items with state='release_requested'.
// Ordered by lastEventAt ASC LIMIT 50.

router.get("/precache/release-queue", requirePluginToken, async (req: PluginAuthRequest, res: Response) => {
  try {
    const rows = await prisma.precacheRequest.findMany({
      where: { state: "release_requested" },
      orderBy: { lastEventAt: "asc" },
      take: 50,
      select: { hash: true, userId: true, lastEventAt: true },
    });

    console.log("precache:release_queue_polled", {
      pluginInstallId: req.pluginTokenId?.slice(0, 8),
      returnedCount: rows.length,
    });

    res.json(rows);
  } catch (err) {
    console.error("[precache] release-queue error:", err);
    res.status(500).json({ error: "Release-Queue konnte nicht geladen werden." });
  }
});

// ─── (a) POST /jellyfin/precache/:hash — User queues item ─────────────────
// Upsert: if no row → create queued; if row exists and state∈{done,failed} → reset to queued;
// otherwise no-op. Returns {state, lastEventAt}.

router.post("/precache/:hash", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const hash = String(req.params.hash);

    if (!hash || hash.length < 1) {
      res.status(400).json({ error: "Hash fehlt." });
      return;
    }

    // Upsert: unique constraint on (userId, hash)
    const existing = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId, hash } },
    });

    if (!existing) {
      const row = await prisma.precacheRequest.create({
        data: { userId, hash, state: "queued", lastEventAt: new Date() },
      });
      console.log("precache:request_created", { userId: userId.slice(0, 8), hash: hash.slice(0, 12) });
      res.status(201).json({ state: row.state, lastEventAt: row.lastEventAt });
      return;
    }

    // Reset done/failed back to queued
    if (existing.state === "done" || existing.state === "failed") {
      const row = await prisma.precacheRequest.update({
        where: { id: existing.id },
        data: {
          state: "queued",
          reason: null,
          lastEventAt: new Date(),
          pluginInstallId: null,
          bytesDownloaded: null,
          sizeBytes: null,
        },
      });
      console.log("precache:request_reset", { userId: userId.slice(0, 8), hash: hash.slice(0, 12), fromState: existing.state });
      res.status(200).json({ state: row.state, lastEventAt: row.lastEventAt });
      return;
    }

    // Already queued or downloading — idempotent
    res.status(200).json({ state: existing.state, lastEventAt: existing.lastEventAt });
  } catch (err) {
    console.error("[precache] POST error:", err);
    res.status(500).json({ error: "Pre-Cache-Request fehlgeschlagen." });
  }
});

// ─── (b) GET /precache/:hash — User polls state ──────────────────────────
// Returns {state, reason, lastEventAt, bytesDownloaded?, sizeBytes?}.
// 404 if no row — client interprets as state=idle.

router.get("/precache/:hash", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const hash = String(req.params.hash);

    const row = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId, hash } },
      select: { state: true, reason: true, lastEventAt: true, bytesDownloaded: true, sizeBytes: true },
    });

    if (!row) {
      res.status(404).json({ error: "Kein Pre-Cache-Request gefunden." });
      return;
    }

    const result: Record<string, unknown> = {
      state: row.state,
      reason: row.reason,
      lastEventAt: row.lastEventAt,
    };
    if (row.bytesDownloaded !== null) result.bytesDownloaded = row.bytesDownloaded.toString();
    if (row.sizeBytes !== null) result.sizeBytes = row.sizeBytes.toString();

    res.json(result);
  } catch (err) {
    console.error("[precache] GET error:", err);
    res.status(500).json({ error: "Pre-Cache-Status konnte nicht geladen werden." });
  }
});

// ─── (e) DELETE /precache/:hash — User requests release ─────────────────
// Sets state='release_requested' — plugin worker handles physical deletion
// and reports final state='released' via the status endpoint.

router.delete("/precache/:hash", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const hash = String(req.params.hash);

    const existing = await prisma.precacheRequest.findUnique({
      where: { userId_hash: { userId, hash } },
    });

    if (!existing) {
      res.status(404).json({ error: "Kein Pre-Cache-Request gefunden." });
      return;
    }

    if (!isValidTransition(existing.state, "release_requested")) {
      res.status(409).json({
        error: `Freigabe nicht möglich im Status: ${existing.state}`,
        fromState: existing.state,
      });
      return;
    }

    const updated = await prisma.precacheRequest.update({
      where: { id: existing.id },
      data: {
        state: "release_requested",
        lastEventAt: new Date(),
      },
    });

    console.log("precache:release_requested", {
      hash: hash.slice(0, 12),
      userId: userId.slice(0, 8),
    });

    res.json({
      state: updated.state,
      lastEventAt: updated.lastEventAt,
    });
  } catch (err) {
    console.error("[precache] DELETE error:", err);
    res.status(500).json({ error: "Freigabe fehlgeschlagen." });
  }
});

// ─── (d) POST /precache/:hash/status — Plugin reports state transition ────
// Body: {state, reason?, bytesDownloaded?, sizeBytes?, pluginInstallId}
// Validates allowed transitions, 409 on invalid.

router.post("/precache/:hash/status", requirePluginToken, async (req: PluginAuthRequest, res: Response) => {
  try {
    const hash = String(req.params.hash);
    const { state: newState, reason, bytesDownloaded, sizeBytes, pluginInstallId } = req.body;

    if (!newState || typeof newState !== "string") {
      res.status(400).json({ error: "state ist erforderlich." });
      return;
    }

    const existing = await prisma.precacheRequest.findFirst({
      where: { hash },
    });

    if (!existing) {
      res.status(404).json({ error: "Kein Pre-Cache-Request für diesen Hash." });
      return;
    }

    if (!isValidTransition(existing.state, newState)) {
      console.log("precache:invalid_transition", {
        hash: hash.slice(0, 12),
        fromState: existing.state,
        toState: newState,
      });
      res.status(409).json({
        error: `Ungültiger Übergang: ${existing.state} → ${newState}`,
        fromState: existing.state,
        toState: newState,
      });
      return;
    }

    const updateData: Record<string, unknown> = {
      state: newState,
      lastEventAt: new Date(),
    };
    if (reason !== undefined) updateData.reason = reason;
    if (pluginInstallId !== undefined) updateData.pluginInstallId = pluginInstallId;
    if (bytesDownloaded !== undefined) updateData.bytesDownloaded = BigInt(bytesDownloaded);
    if (sizeBytes !== undefined) updateData.sizeBytes = BigInt(sizeBytes);

    const updated = await prisma.precacheRequest.update({
      where: { id: existing.id },
      data: updateData,
    });

    console.log("precache:status_updated", {
      hash: hash.slice(0, 12),
      fromState: existing.state,
      toState: newState,
      reason: reason || undefined,
    });

    res.json({
      state: updated.state,
      reason: updated.reason,
      lastEventAt: updated.lastEventAt,
    });
  } catch (err) {
    console.error("[precache] status update error:", err);
    res.status(500).json({ error: "Status-Update fehlgeschlagen." });
  }
});

export default router;
