import express from "express";
import cors from "cors";
import prisma from "./lib/prisma.js";
import authRoutes from "./routes/auth.js";
import watchlistRoutes from "./routes/watchlist.js";
import nzbRoutes from "./routes/nzb.js";
import downloadsRoutes from "./routes/downloads.js";
import storageRoutes from "./routes/storage.js";
import uploadRoutes from "./routes/uploads.js";
import configRoutes from "./routes/config.js";
import adminConfigRoutes from "./routes/admin-config.js";
import serviceApiRoutes from "./routes/service-api.js";
import libraryRoutes from "./routes/library.js";
import searchHistoryRoutes from "./routes/search-history.js";
import testRoutes from "./routes/test.js";
import { errorHandler } from "./middleware/error-handler.js";

export function createApp() {
  const app = express();

  app.use(cors());

  // NZB uploads can be several MB — apply a larger limit only to that route.
  // Mount the larger parser BEFORE the global one so /downloads/request matches first.
  app.use("/downloads/request", express.json({ limit: "50mb" }));

  // All other routes use a tight default limit to minimize DoS surface.
  app.use(express.json({ limit: "1mb" }));

  app.use("/auth", authRoutes);
  app.use("/watchlist", watchlistRoutes);
  app.use("/nzb", nzbRoutes);
  app.use("/downloads", downloadsRoutes);
  app.use("/uploads", uploadRoutes);
  app.use("/storage", storageRoutes);
  app.use("/config", configRoutes);
  app.use("/admin/config", adminConfigRoutes);
  app.use("/service", serviceApiRoutes);
  app.use("/library", libraryRoutes);
  app.use("/search-history", searchHistoryRoutes);

  // Test-only routes are mounted ONLY when NODE_ENV === "test". This keeps
  // the /test/* paths absent from the request pipeline in production. The
  // router itself also has an internal guard as defense-in-depth, so even
  // if NODE_ENV flipped at runtime (it doesn't) requests would still 404.
  if (process.env.NODE_ENV === "test") {
    app.use("/test", testRoutes);
    console.log("[app] Test routes mounted at /test (NODE_ENV=test)");
  }

  // Health check with DB status
app.get("/health", async (_req, res) => {
  let dbStatus = "unknown";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "connected";
  } catch {
    dbStatus = "disconnected";
  }

  res.json({
    status: "ok",
    version: "0.1.0",
    db: dbStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

  app.use(errorHandler);

  return app;
}

export default createApp;
