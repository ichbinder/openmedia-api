import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    setupFiles: ["./e2e/setup.ts"],
    testTimeout: 30000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
