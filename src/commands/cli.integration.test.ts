/**
 * Integration tests for CLI version output
 *
 * These tests run the actual built CLI to catch version resolution bugs
 * that unit tests with mocks might miss (e.g., path resolution issues).
 *
 * Issue #86: The getCurrentVersion() bug (returning 0.0.0) passed all unit
 * tests because they mocked `fs`. We only caught it after releasing v1.5.4.
 */

import {
  execSync,
  spawnSync,
  ExecSyncOptionsWithStringEncoding,
} from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

// Build handled by vitest globalSetup (vitest.global-setup.ts). Fail loudly if
// it is missing rather than skip (#842 AC-6) — this file previously carried a
// `describe.skipIf(!distExists)` block whose only test asserted
// `expect(distExists).toBe(true)`, i.e. it was skipped in exactly the case it
// would have failed, so it could never fail at all.
beforeAll(() => {
  if (!existsSync(cliPath)) {
    throw new Error(
      `dist/bin/cli.js not found at ${cliPath}. Run 'npm run build' first.`,
    );
  }
});

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
  // CLI parses flags without executing a real workflow.
  //
  // These tests run in the repo root, which is not itself an initialized Sequant
  // project, so every run trips the not-initialized pre-flight guard in run.ts.
  // That guard prints "Sequant is not initialized" — but only *after* Commander
  // has parsed every flag, so reaching it proves the flag under test was accepted.
  // Since #848 the guard exits 1 (was 0), so exit-0 is no longer a valid
  // "parsed OK" proxy; assert on the guard's output instead. A genuine Commander
  // usage error (unknown option) never reaches the guard and prints
  // "error: unknown option" to stderr.
  const expectFlagAccepted = (flag: string): void => {
    const r = spawnSync(
      process.execPath,
      [cliPath, "run", "1", flag, "--dry-run"],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    // Reached the pre-flight guard ⇒ Commander parsed every flag, incl. `flag`.
    expect(stdout + stderr).toMatch(/Sequant is not initialized/);
    // ...and it was not rejected as an unknown option.
    expect(stderr).not.toMatch(/error: unknown option/);
  };

  it("-q parses without error (hidden quality-loop alias) (AC-1)", () => {
    // Proves the hidden `-q` alias is accepted by Commander.
    expectFlagAccepted("-q");
  });

  it("-Q parses without error (AC-1)", () => {
    expectFlagAccepted("-Q");
  });

  it("--experimental-tui still parses as a hidden no-op alias (AC-5)", () => {
    expectFlagAccepted("--experimental-tui");
  });

  it("--no-tui parses without error (AC-4)", () => {
    expectFlagAccepted("--no-tui");
  });

  // #795 AC-2: --qa-gate is deprecated to a no-op. It must keep parsing so
  // existing scripts don't hard-error, must warn, and must no longer abort the
  // run when --chain is absent.
  describe("#795: --qa-gate deprecation", () => {
    // The notice goes to stderr (it is a warning), so these assertions need
    // both streams — `runDryRun` above returns stdout only. spawnSync rather
    // than a `2>&1` / `2>/dev/null` execSync: no shell means no cmd.exe-vs-sh
    // redirection difference, and the streams stay separable so a single run
    // can assert "on stderr AND not on stdout".
    const runDryRunStreams = (
      ...flags: string[]
    ): { stdout: string; stderr: string } => {
      const r = spawnSync(
        process.execPath,
        [cliPath, "run", "1", ...flags, "--dry-run"],
        { cwd: projectRoot, encoding: "utf-8" },
      );
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    it("--qa-gate without --chain warns instead of aborting the run", () => {
      const { stdout, stderr } = runDryRunStreams("--qa-gate");

      // Before #795 this printed "❌ --qa-gate requires --chain flag" and
      // returned early, so the run never started. Both halves matter: the
      // notice must appear AND the old abort message must be gone.
      expect(stderr).toMatch(/--qa-gate is deprecated/);
      expect(stdout + stderr).not.toMatch(/requires --chain/);
    });

    it("--qa-gate with --chain still parses and warns", () => {
      expect(runDryRunStreams("--qa-gate", "--chain").stderr).toMatch(
        /--qa-gate is deprecated/,
      );
    });

    it("routes the notice to stderr, keeping stdout clean", () => {
      // A consuming script that pipes stdout must not receive the warning.
      expect(runDryRunStreams("--qa-gate").stdout).not.toMatch(
        /--qa-gate is deprecated/,
      );
    });

    it("still warns under --quiet (a warning, not progress output)", () => {
      // --quiet suppresses version chatter and progress; it is not a warning
      // switch. CI scripts are the likeliest to still pass --qa-gate AND the
      // likeliest to pass --quiet, so gating here would silence the
      // deprecation for exactly its target audience.
      expect(runDryRunStreams("--qa-gate", "--quiet").stderr).toMatch(
        /--qa-gate is deprecated/,
      );
    });

    it("run --help describes --qa-gate as deprecated, not as gating", () => {
      const help = execSync(`node ${cliPath} run --help`, execOptions);

      expect(help).toMatch(/--qa-gate/);
      expect(help).toMatch(/DEPRECATED/);
      // The removed promise: help text must no longer claim it waits for QA.
      expect(help).not.toMatch(/Wait for QA pass/);
    });
  });
});
