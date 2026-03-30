import { createApp } from "./app.js";

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`[server] CineScope API running on http://localhost:${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
import prisma from "./lib/prisma.js";

process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received, shutting down...");
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[server] SIGINT received, shutting down...");
  await prisma.$disconnect();
  process.exit(0);
});
