import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import { signToken, requireAuth, type AuthRequest } from "../middleware/auth.js";
import { generateApiToken, ALLOWED_EXPIRY_DAYS, MAX_TOKENS_PER_USER, type ExpiryDays } from "../lib/api-token.js";

const router = Router();

// POST /auth/register
router.post("/register", async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: "E-Mail, Passwort und Name sind erforderlich." });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: "Passwort muss mindestens 6 Zeichen lang sein." });
      return;
    }

    // Check if user exists
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) {
      res.status(409).json({ error: "Ein Konto mit dieser E-Mail existiert bereits." });
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        name,
        password: hashedPassword,
      },
    });

    // Generate token
    const token = signToken({ userId: user.id, email: user.email });

    console.log(`[auth] User registered: ${user.email}`);

    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name },
      token,
    });
  } catch (err) {
    console.error("[auth] Register error:", err);
    res.status(500).json({ error: "Registrierung fehlgeschlagen." });
  }
});

// POST /auth/login
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "E-Mail und Passwort sind erforderlich." });
      return;
    }

    // Find user
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) {
      res.status(401).json({ error: "E-Mail oder Passwort ist falsch." });
      return;
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: "E-Mail oder Passwort ist falsch." });
      return;
    }

    // Generate token
    const token = signToken({ userId: user.id, email: user.email });

    console.log(`[auth] User logged in: ${user.email}`);

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      token,
    });
  } catch (err) {
    console.error("[auth] Login error:", err);
    res.status(500).json({ error: "Anmeldung fehlgeschlagen." });
  }
});

// GET /auth/me — get current user from token
router.get("/me", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, email: true, name: true, createdAt: true },
    });

    if (!user) {
      res.status(404).json({ error: "Benutzer nicht gefunden." });
      return;
    }

    res.json({ user });
  } catch (err) {
    console.error("[auth] Me error:", err);
    res.status(500).json({ error: "Fehler beim Laden der Benutzerdaten." });
  }
});

// POST /auth/logout — client-side only (clear cookie), but endpoint exists for completeness
router.post("/logout", (_req: Request, res: Response) => {
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// API Token Management
// ---------------------------------------------------------------------------

/**
 * POST /auth/api-tokens — Create a new API token.
 * Body: { name: string, expiresInDays: 30 | 60 | 90 }
 * Returns the plaintext token ONCE. It is never stored or returned again.
 */
router.post("/api-tokens", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { name, expiresInDays } = req.body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Name ist erforderlich." });
      return;
    }

    if (name.trim().length > 100) {
      res.status(400).json({ error: "Name darf maximal 100 Zeichen lang sein." });
      return;
    }

    const days = Number(expiresInDays);
    if (!ALLOWED_EXPIRY_DAYS.includes(days as ExpiryDays)) {
      res.status(400).json({ error: `expiresInDays muss einer von ${ALLOWED_EXPIRY_DAYS.join(", ")} sein.` });
      return;
    }

    // Enforce per-user token limit
    const activeCount = await prisma.apiToken.count({
      where: { userId: req.user!.userId, revokedAt: null },
    });
    if (activeCount >= MAX_TOKENS_PER_USER) {
      res.status(400).json({ error: `Maximal ${MAX_TOKENS_PER_USER} aktive Tokens erlaubt. Bitte einen bestehenden widerrufen.` });
      return;
    }

    const { plaintext, hash, prefix } = generateApiToken();
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const token = await prisma.apiToken.create({
      data: {
        userId: req.user!.userId,
        tokenHash: hash,
        tokenPrefix: prefix,
        name: name.trim(),
        expiresAt,
      },
    });

    console.log(`[auth] API token created: ${prefix}... for user ${req.user!.userId.slice(0, 8)}... (expires ${expiresAt.toISOString().slice(0, 10)})`);

    res.status(201).json({
      token: plaintext, // shown ONCE — never returned again
      id: token.id,
      name: token.name,
      prefix: token.tokenPrefix,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    });
  } catch (err) {
    console.error("[auth] Create API token error:", err);
    res.status(500).json({ error: "Token-Erstellung fehlgeschlagen." });
  }
});

/**
 * GET /auth/api-tokens — List all API tokens for the current user.
 * Returns metadata only — never the hash or plaintext.
 */
router.get("/api-tokens", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const tokens = await prisma.apiToken.findMany({
      where: { userId: req.user!.userId },
      select: {
        id: true,
        tokenPrefix: true,
        name: true,
        expiresAt: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({ tokens });
  } catch (err) {
    console.error("[auth] List API tokens error:", err);
    res.status(500).json({ error: "Token-Liste konnte nicht geladen werden." });
  }
});

/**
 * DELETE /auth/api-tokens/:id — Revoke an API token (soft-delete via revokedAt).
 */
router.delete("/api-tokens/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    const token = await prisma.apiToken.findUnique({ where: { id } });

    if (!token || token.userId !== req.user!.userId) {
      res.status(404).json({ error: "Token nicht gefunden." });
      return;
    }

    if (token.revokedAt) {
      res.status(400).json({ error: "Token ist bereits widerrufen." });
      return;
    }

    await prisma.apiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    console.log(`[auth] API token revoked: ${token.tokenPrefix}... for user ${req.user!.userId.slice(0, 8)}...`);

    res.json({ success: true });
  } catch (err) {
    console.error("[auth] Revoke API token error:", err);
    res.status(500).json({ error: "Token konnte nicht widerrufen werden." });
  }
});

export default router;
