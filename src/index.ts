import { createApp } from "./app.js";
import { startReconciler, stopReconciler } from "./lib/job-reconciler.js";

const PORT = process.env.PORT || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`[server] CineScope API running on http://localhost:${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/health`);

  // Start background job reconciler (detects stuck/orphaned download jobs)
  startReconciler();
});

// Graceful shutdown
import prisma from "./lib/prisma.js";

async function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down...`);
  stopReconciler();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
