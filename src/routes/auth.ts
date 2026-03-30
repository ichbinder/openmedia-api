import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import prisma from "../lib/prisma.js";
import { signToken, requireAuth, type AuthRequest } from "../middleware/auth.js";

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

export default router;
