import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../lib/prisma.js";
import { isApiToken, hashToken } from "../lib/api-token.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

export interface JwtPayload {
  userId: string;
  email: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

/**
 * Auth middleware — accepts both JWT (from web login) and om_ API tokens (from extension).
 * Sets req.user on success, returns 401 on failure.
 */
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Nicht authentifiziert." });
    return;
  }

  const token = authHeader.slice(7);

  // --- API Token path (om_ prefix) ---
  if (isApiToken(token)) {
    authenticateApiToken(token, req, res, next);
    return;
  }

  // --- JWT path (web login) ---
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Sitzung abgelaufen. Bitte erneut einloggen." });
      return;
    }
    res.status(401).json({ error: "Ungültiger Token." });
    return;
  }
}

/**
 * Authenticate an om_ API token via DB lookup.
 * Checks: exists, not revoked, not expired. Updates lastUsedAt (fire-and-forget).
 */
async function authenticateApiToken(
  plaintext: string,
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tokenHash = hashToken(plaintext);

    const apiToken = await prisma.apiToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!apiToken) {
      res.status(401).json({ error: "Ungültiger API-Token." });
      return;
    }

    if (apiToken.revokedAt) {
      console.log(`[auth] Token rejected (revoked): ${apiToken.tokenPrefix}...`);
      res.status(401).json({ error: "API-Token wurde widerrufen." });
      return;
    }

    if (apiToken.expiresAt < new Date()) {
      console.log(`[auth] Token rejected (expired): ${apiToken.tokenPrefix}...`);
      res.status(401).json({ error: "API-Token ist abgelaufen." });
      return;
    }

    // Set user context — same shape as JWT payload
    req.user = { userId: apiToken.user.id, email: apiToken.user.email };

    // Update lastUsedAt (fire-and-forget — don't block the request)
    prisma.apiToken
      .update({ where: { id: apiToken.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => console.error(`[auth] Failed to update lastUsedAt: ${err.message}`));

    console.log(`[auth] API-Token auth: ${apiToken.user.email} via ${apiToken.tokenPrefix}...`);
    next();
  } catch (err) {
    console.error("[auth] API token auth error:", err);
    res.status(500).json({ error: "Token-Authentifizierung fehlgeschlagen." });
  }
}
