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
import { describe, it, expect } from "vitest";
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
  // Build handled by vitest globalSetup (vitest.global-setup.ts)

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
    // Retry once — CI runners occasionally kill the child process via signal
    // (e.g., OOM or resource pressure), producing empty stdout.
    let output = "";
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        output = execSync(`node ${cliPath} status`, execOptions);
        break;
      } catch (error) {
        const execError = error as {
          status: number | null;
          stdout: string;
          stderr: string;
          signal?: string;
        };
        output = execError.stdout || "";

        // Process killed by signal (status is null) — retry if possible
        if (execError.status === null) {
          if (attempt < maxAttempts) continue;
          throw new Error(
            `CLI status killed by signal ${execError.signal || "unknown"} after ${maxAttempts} attempts.\n` +
              `stdout: ${JSON.stringify(output)}\n` +
              `stderr: ${execError.stderr}`,
          );
        }

        // Non-zero exit with no stdout — crash
        if (execError.status !== 0 && !output) {
          throw new Error(
            `CLI status crashed with exit code ${execError.status}.\n` +
              `stderr: ${execError.stderr}`,
          );
        }

        // Non-zero exit but has stdout — use it (status may exit non-zero if not initialized)
        break;
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

// Issue #705: reverse the #658 binding. `-q` no longer maps to --quiet (it is
// now a hidden alias for the quality loop); --quiet moved to `-s`. The boxed
// Ink TUI is the default, with `--no-tui` to opt out and `--experimental-tui`
// kept as a hidden no-op alias. These tests assert the help surface; the
// alias-normalization and tuiEnabled behavior are unit-tested in run.test.ts.
describe("run command flag surface (#705)", () => {
  const runHelp = (): string => {
    try {
      return execSync(`node ${cliPath} run --help`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      throw new Error(
        `CLI run --help crashed with exit code ${execError.status}.\n` +
          `stdout: ${execError.stdout}\n` +
          `stderr: ${execError.stderr}`,
      );
    }
  };

  it("--quiet is reachable via -s, not -q (AC-2)", () => {
    const output = runHelp();
    expect(output).toMatch(/-s,\s*--quiet/);
    expect(output).not.toMatch(/-q,\s*--quiet/);
  });

  it("-Q binds to --quality-loop (AC-1)", () => {
    const output = runHelp();
    expect(output).toMatch(/-Q,\s*--quality-loop/);
  });

  it("the -q quality-loop alias is hidden from help (AC-1)", () => {
    const output = runHelp();
    // Hidden alias Option must not surface in --help, but must still parse
    // (covered by the parse test below).
    expect(output).not.toMatch(/--quality-loop-alias/);
  });

  it("--no-tui is documented; --experimental-tui is hidden (AC-4, AC-5)", () => {
    const output = runHelp();
    expect(output).toMatch(/--no-tui/);
    expect(output).not.toMatch(/--experimental-tui/);
  });

  // AC-1: `-q` and `-Q` both enable the quality loop and neither enables quiet.
  // AC-5: `--experimental-tui` still parses without error. Use --dry-run so the
  // CLI parses flags and exits without executing a real workflow.
  const runDryRun = (flag: string): string => {
    try {
      return execSync(`node ${cliPath} run 1 ${flag} --dry-run`, execOptions);
    } catch (error) {
      const execError = error as {
        status: number | null;
        stdout: string;
        stderr: string;
      };
      // A parse error exits non-zero with the message on stderr; surface it so
      // the assertion fails with context rather than a generic throw.
      throw new Error(
        `CLI run 1 ${flag} --dry-run crashed with exit code ${execError.status}.\n` +
          `stdout: ${execError.stdout}\n` +
          `stderr: ${execError.stderr}`,
      );
    }
  };

  it("-q parses without error (hidden quality-loop alias) (AC-1)", () => {
    // Must not throw — proves the hidden `-q` alias is accepted by Commander.
    expect(() => runDryRun("-q")).not.toThrow();
  });

  it("-Q parses without error (AC-1)", () => {
    expect(() => runDryRun("-Q")).not.toThrow();
  });

  it("--experimental-tui still parses as a hidden no-op alias (AC-5)", () => {
    expect(() => runDryRun("--experimental-tui")).not.toThrow();
  });

  it("--no-tui parses without error (AC-4)", () => {
    expect(() => runDryRun("--no-tui")).not.toThrow();
  });
});
