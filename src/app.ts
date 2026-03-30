import express from "express";
import cors from "cors";
import prisma from "./lib/prisma.js";
import authRoutes from "./routes/auth.js";
import watchlistRoutes from "./routes/watchlist.js";
import { errorHandler } from "./middleware/error-handler.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use("/auth", authRoutes);
  app.use("/watchlist", watchlistRoutes);

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
