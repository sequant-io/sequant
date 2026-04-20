import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build once before all tests (used by cli/doctor integration tests)
    globalSetup: "./vitest.global-setup.ts",

    projects: [
      {
        name: "unit",
        test: {
          include: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "!**/*.integration.test.ts",
            // Subprocess-heavy tests run in the integration project
            "!scripts/qa/tautology-detector-cli.test.ts",
            "!src/lib/semgrep.test.ts",
          ],
          pool: "forks",
          hookTimeout: 60000,
          teardownTimeout: 10000,
        },
      },
      {
        name: "integration",
        test: {
          include: [
            "**/*.integration.test.ts",
            "scripts/qa/tautology-detector-cli.test.ts",
            "src/lib/semgrep.test.ts",
          ],
          pool: "forks",
          hookTimeout: 60000,
          teardownTimeout: 10000,
          // Run integration tests sequentially to avoid port conflicts
          // and CPU contention from concurrent subprocess spawning
          fileParallelism: false,
        },
      },
    ],
  },
});
