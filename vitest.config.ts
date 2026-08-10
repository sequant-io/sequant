import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build once before all tests (used by cli/doctor integration tests)
    globalSetup: "./vitest.global-setup.ts",

    // Each project's `name` must sit INSIDE its `test` block. Vitest 4 does
    // not read a `name` declared as a sibling of `test`, and the symptom is
    // not an error at config load — it is `--project unit` failing with
    // "No projects matched the filter", which reads like a typo in the
    // command rather than a config defect. Both projects still ran, so the
    // only thing lost was the ability to target one of them: the #842
    // separation between the 5 s unit project and the serialized 30 s
    // integration project could not be verified from the command line.
    projects: [
      {
        test: {
          name: "unit",
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
        test: {
          name: "integration",
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
