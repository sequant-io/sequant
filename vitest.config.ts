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
          // Subprocess-spawning tests must not inherit the 5s default, which
          // is sized for in-process unit tests. A CLI spawn alone measured
          // 7.5-17.8s under full-suite load (#842), so the default was a
          // guaranteed flake for every test in this project that shells out.
          // Deliberately scoped to `integration` — the `unit` project keeps
          // vitest's 5s default, where a slow test is a real signal.
          // Files needing more override it locally (see
          // sync-source-invocation.integration.test.ts).
          testTimeout: 30_000,
          // Run integration tests sequentially to avoid port conflicts
          // and CPU contention from concurrent subprocess spawning
          fileParallelism: false,
        },
      },
    ],
  },
});
