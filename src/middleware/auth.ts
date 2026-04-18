import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { timingSafeEqual } from "node:crypto";
import prisma from "../lib/prisma.js";
import { isApiToken, hashToken } from "../lib/api-token.js";
import { validateServiceToken } from "../lib/service-token.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

export interface JwtPayload {
  userId: string;
  email: string;
}

export interface ServiceTokenPayload {
  jobId: string;
  jobType: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  serviceToken?: ServiceTokenPayload;
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
/**
 * Admin middleware — checks if the authenticated user's email is in ADMIN_EMAILS.
 * Must be used after requireAuth.
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (!req.user?.email || !adminEmails.includes(req.user.email.toLowerCase())) {
    res.status(403).json({ error: "Admin-Zugriff erforderlich." });
    return;
  }

  next();
}

/**
 * Service token middleware — validates machine-to-machine auth.
 * Fast path: static SERVICE_API_TOKEN (backward compat).
 * Slow path: per-VPS token looked up in ServiceToken table.
 */
export function requireServiceToken(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!provided) {
    res.status(401).json({ error: "Missing service token." });
    return;
  }

  // Fast path: static ENV token (backward compat)
  const staticToken = process.env.SERVICE_API_TOKEN;
  if (staticToken && provided.length === staticToken.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(staticToken))) {
    next();
    return;
  }

  // Slow path: DB-stored per-VPS token
  validateServiceToken(provided)
    .then((tokenRecord) => {
      if (!tokenRecord) {
        console.log("[auth] Service token rejected: not found in static ENV or DB");
        res.status(401).json({ error: "Invalid service token." });
        return;
      }
      req.serviceToken = { jobId: tokenRecord.jobId, jobType: tokenRecord.jobType };
      console.log(`[auth] Service token validated for job ${tokenRecord.jobId}`);
      next();
    })
    .catch((err) => {
      console.error("[auth] Service token DB lookup error:", err);
      res.status(500).json({ error: "Service token validation failed." });
    });
}

/**
 * Combined middleware — tries user auth first (JWT / API token), falls back to service token.
 * Sets either req.user or req.serviceToken on the request.
 */
export function requireServiceOrUserAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    res.status(401).json({ error: "Nicht authentifiziert." });
    return;
  }

  // Try user auth paths first (JWT or om_ API token)
  if (isApiToken(token)) {
    authenticateApiToken(token, req, res, next);
    return;
  }

  // Try JWT
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
    return;
  } catch {
    // JWT failed — fall through to service token
  }

  // Fall back to service token
  requireServiceToken(req, res, next);
}

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

    console.log(`[auth] API-Token auth: user ${apiToken.user.id.slice(0, 8)}... via ${apiToken.tokenPrefix}...`);
    next();
  } catch (err) {
    console.error("[auth] API token auth error:", err);
    res.status(500).json({ error: "Token-Authentifizierung fehlgeschlagen." });
  }
}
