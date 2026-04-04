import { execSync } from "child_process";

/**
 * Global setup for vitest — runs once before all test files.
 *
 * Builds the project so integration tests that shell out to
 * `node dist/bin/cli.js` don't each need their own beforeAll build.
 */
export default function setup() {
  execSync("npm run build", { stdio: "ignore" });
}
