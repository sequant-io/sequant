/**
 * Integration tests for CLI version output
 *
 * These tests run the actual built CLI to catch version resolution bugs
 * that unit tests with mocks might miss (e.g., path resolution issues).
 *
 * Issue #86: The getCurrentVersion() bug (returning 0.0.0) passed all unit
 * tests because they mocked `fs`. We only caught it after releasing v1.5.4.
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");
const distExists = existsSync(resolve(projectRoot, "dist"));

// Read package.json version for comparison
const packageJson = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf-8"),
);
const expectedVersion = packageJson.version;

const execOptions: ExecSyncOptionsWithStringEncoding = {
  cwd: projectRoot,
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "pipe"],
};

describe("CLI version integration", () => {
  beforeAll(() => {
    // Build the project before running integration tests
    // This ensures dist/ exists for the tests
    execSync("npm run build", {
      cwd: projectRoot,
      stdio: "ignore",
    });
  }, 30000); // 30 second timeout for build

  it("--version reports correct version from package.json", () => {
    let output: string;

    try {
      output = execSync(`node ${cliPath} --version`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      throw new Error(
        `CLI --version crashed with exit code ${execError.status}.\n` +
          `stdout: ${execError.stdout}\n` +
          `stderr: ${execError.stderr}`,
      );
    }

    // Version output should match package.json exactly
    expect(output.trim()).toBe(expectedVersion);

    // Ensure we're not getting the fallback 0.0.0
    expect(output.trim()).not.toBe("0.0.0");
  });

  it("status command shows correct package version", () => {
    let output: string;

    try {
      output = execSync(`node ${cliPath} status`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      // Status may exit with non-zero if not initialized, but shouldn't crash
      output = execError.stdout || "";

      if (execError.status !== null && execError.status !== 0) {
        // If it exited with error, make sure we still got output
        if (!output) {
          throw new Error(
            `CLI status crashed with exit code ${execError.status}.\n` +
              `stderr: ${execError.stderr}`,
          );
        }
      }
    }

    // Status should include "Package version: X.X.X"
    expect(output).toContain(`Package version: ${expectedVersion}`);

    // Ensure we're not getting the fallback 0.0.0
    expect(output).not.toContain("Package version: 0.0.0");
  });

  it("-V (short version flag) reports correct version", () => {
    let output: string;

    try {
      output = execSync(`node ${cliPath} -V`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      throw new Error(
        `CLI -V crashed with exit code ${execError.status}.\n` +
          `stdout: ${execError.stdout}\n` +
          `stderr: ${execError.stderr}`,
      );
    }

    expect(output.trim()).toBe(expectedVersion);
  });
});

// Separate describe block for tests that should be skipped if dist/ doesn't exist
// This allows the main tests to build first, but provides a skip mechanism for docs
describe.skipIf(!distExists)("CLI version (pre-built)", () => {
  it("dist/ directory exists", () => {
    expect(distExists).toBe(true);
  });
});
