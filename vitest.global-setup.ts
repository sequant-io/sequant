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

  execSync("npm run build", { stdio: "ignore" });
}
