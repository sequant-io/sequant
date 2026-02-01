/**
 * Integration tests for the doctor command
 *
 * These tests run the actual CLI as a subprocess to catch runtime errors
 * that unit tests with mocks might miss (e.g., ESM import issues).
 *
 * Issue #60: Unit tests mock all system functions, missing runtime errors
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

const execOptions: ExecSyncOptionsWithStringEncoding = {
  cwd: projectRoot,
  encoding: "utf-8",
  // Capture both stdout and stderr
  stdio: ["pipe", "pipe", "pipe"],
};

describe("doctor command integration", { timeout: 60000 }, () => {
  beforeAll(() => {
    // Build the project before running integration tests
    execSync("npm run build", {
      cwd: projectRoot,
      stdio: "ignore",
    });
  }, 30000); // 30 second timeout for build

  it("runs without crashing", () => {
    let output: string;
    let exitCode: number | null = 0;

    try {
      output = execSync(`node ${cliPath} doctor`, execOptions);
    } catch (error) {
      // execSync throws on non-zero exit codes
      // We accept exit code 1 (some checks fail) as valid in CI environments
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      exitCode = execError.status;
      output = execError.stdout || "";

      // Only exit codes 0 (all pass) and 1 (some checks fail) are acceptable
      // Any other exit code indicates a crash or uncaught exception
      if (exitCode !== null && exitCode !== 0 && exitCode !== 1) {
        throw new Error(
          `Doctor command crashed with exit code ${exitCode}.\n` +
            `stdout: ${execError.stdout}\n` +
            `stderr: ${execError.stderr}`,
        );
      }
    }

    // Verify the command actually ran and produced expected output (new boxed header)
    expect(output).toContain("SEQUANT HEALTH CHECK");

    // Accept both exit code 0 (all pass) and 1 (some checks fail in CI)
    expect([0, 1]).toContain(exitCode);
  });

  it("shows help without crashing", () => {
    let output: string;

    try {
      output = execSync(`node ${cliPath} doctor --help`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      throw new Error(
        `Doctor --help crashed with exit code ${execError.status}.\n` +
          `stdout: ${execError.stdout}\n` +
          `stderr: ${execError.stderr}`,
      );
    }

    // Verify help output contains expected content
    expect(output).toContain("doctor");
    expect(output).toContain("Check your Sequant installation");
  });
});
