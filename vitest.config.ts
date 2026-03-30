import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15000,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
    env: {
      DATABASE_URL: "postgresql://cinescope_test:cinescope_test@localhost:5433/cinescope_test",
      JWT_SECRET: "test-secret-for-testing-only",
      NODE_ENV: "test",
    },
  },
});
