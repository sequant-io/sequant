import { execSync } from "child_process";

/**
 * Global setup for vitest — runs once before all test files.
 *
 * Builds the project so integration tests that shell out to
 * `node dist/bin/cli.js` don't each need their own beforeAll build.
 */
export default function setup() {
  // Hermetic git: tests that create throwaway repos must not inherit the
  // contributor's global/system git config. Workers are forked after this
  // runs, so they inherit these.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";

  // Hermetic against the orchestrator: every phase runs with injected
  // variables (#1086) that change what the code under test does. Scrub by
  // prefix so a new phase variable can't reintroduce the leak.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SEQUANT_")) delete process.env[key];
  }

  execSync("npm run build", { stdio: "ignore" });
}
