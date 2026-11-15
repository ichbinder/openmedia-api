import { Router, type Response } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth.js";
import { fetchTraktLibrary, pollDeviceToken, revokeToken, startDeviceLogin } from "../lib/trakt.js";
import { importTraktLibrary } from "../lib/trakt-import.js";

const router = Router();
router.use(requireAuth);

const pendingLogins = new Map<string, { deviceCode: string; expiresAt: number }>();

router.post("/connect", async (req: AuthRequest, res: Response) => {
  try {
    const login = await startDeviceLogin();
    if (login === "not_configured") {
      res.status(503).json({ error: "Trakt ist nicht eingerichtet." });
      return;
    }
    pendingLogins.set(req.user!.userId, {
      deviceCode: login.deviceCode,
      expiresAt: Date.now() + login.expiresIn * 1000,
    });
    const { userCode, verificationUrl, expiresIn, interval } = login;
    res.json({ userCode, verificationUrl, expiresIn, interval });
  } catch (err) {
    console.error("[trakt] Verbindung fehlgeschlagen:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Trakt ist nicht erreichbar." });
  }
});

router.post("/poll", async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const pending = pendingLogins.get(userId);
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingLogins.delete(userId);
    res.json({ status: "expired" });
    return;
  }

  try {
    const result = await pollDeviceToken(pending.deviceCode);
    if (result.status === "pending") {
      res.json({ status: "pending" });
      return;
    }
    pendingLogins.delete(userId);
    if (result.status !== "done") {
      res.json({ status: result.status });
      return;
    }
    try {
      const counts = await importTraktLibrary(userId, await fetchTraktLibrary(result.accessToken));
      await revokeToken(result.accessToken);
      res.json({ status: "done", counts });
    } catch (err) {
      await revokeToken(result.accessToken);
      throw err;
    }
  } catch (err) {
    console.error("[trakt] Import fehlgeschlagen:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Trakt-Import fehlgeschlagen." });
  }
});

export default router;
