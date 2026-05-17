import { type Request, type Response, type NextFunction } from "express";
import prisma from "../lib/prisma.js";
import { hashToken, isApiToken } from "../lib/api-token.js";

/**
 * Plugin authentication payload added to req when a valid plugin token is present.
 */
export interface PluginUser {
  userId: string;
  tokenId: string;
}

export interface PluginAuthRequest extends Request {
  pluginUser?: PluginUser;
}

/**
 * Middleware: requirePluginToken
 *
 * Validates that the request carries a valid om_-token with purpose='jellyfin-plugin'.
 * Only the Jellyfin plugin (not regular users) should call /queue and /:hash/status.
 *
 * On success: sets req.pluginUser = { userId, tokenId } and calls next().
 * On failure: responds 401.
 */
export function requirePluginToken(req: PluginAuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header fehlt." });
    return;
  }

  const token = authHeader.slice(7);

  if (!isApiToken(token)) {
    res.status(401).json({ error: "Ungültiger Token-Typ." });
    return;
  }

  const tokenHash = hashToken(token);

  prisma.apiToken
    .findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tokenPrefix: true,
        purpose: true,
        revokedAt: true,
        expiresAt: true,
      },
    })
    .then((apiToken) => {
      if (!apiToken) {
        res.status(401).json({ error: "Token nicht gefunden." });
        return;
      }

      if (apiToken.purpose !== "jellyfin-plugin") {
        console.log(
          `[plugin-auth] rejected: wrong purpose=${apiToken.purpose} token=${apiToken.tokenPrefix}...`,
        );
        res.status(401).json({ error: "Token nicht für Plugin-Zugriff freigegeben." });
        return;
      }

      if (apiToken.revokedAt) {
        console.log(`[plugin-auth] rejected: revoked token=${apiToken.tokenPrefix}...`);
        res.status(401).json({ error: "Token wurde widerrufen." });
        return;
      }

      if (apiToken.expiresAt < new Date()) {
        console.log(`[plugin-auth] rejected: expired token=${apiToken.tokenPrefix}...`);
        res.status(401).json({ error: "Token ist abgelaufen." });
        return;
      }

      req.pluginUser = { userId: apiToken.userId, tokenId: apiToken.id };

      // Fire-and-forget lastUsedAt update
      prisma.apiToken
        .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
        .catch((err) => console.error(`[plugin-auth] lastUsedAt update failed: ${err.message}`));

      console.log(
        `[plugin-auth] ok: user=${apiToken.userId.slice(0, 8)}... token=${apiToken.tokenPrefix}...`,
      );
      next();
    })
    .catch((err) => {
      console.error("[plugin-auth] DB lookup error:", err);
      res.status(500).json({ error: "Plugin-Token-Validierung fehlgeschlagen." });
    });
}
