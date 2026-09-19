/**
 * Integration tests for the doctor command
 *
 * These tests run the actual CLI as a subprocess to catch runtime errors
 * that unit tests with mocks might miss (e.g., ESM import issues).
 *
 * Issue #60: Unit tests mock all system functions, missing runtime errors
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  getCodexVersion,
  getOpencodeVersion,
  isCodexAuthenticated,
} from "./doctor.js";

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
  // Build handled by vitest globalSetup (vitest.global-setup.ts)

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

/**
 * Probe timeouts (#1075 AC-2/AC-3/AC-4).
 *
 * The three CLI probes in `doctor.ts` shell out with `execSync`. Before #1075
 * none passed a `timeout`, so a hung binary — or, for `codex login status`, a
 * stalled network request — hung `sequant doctor` with no output and no way
 * out but Ctrl-C.
 *
 * Each case puts a stub at the front of `PATH` that sleeps far longer than the
 * probe's bound, then asserts both the documented fallback value *and* the
 * elapsed wall time. The wall-time assertion is the real gate: a stub that
 * prints nothing already yields `undefined` from the version regex miss, so
 * the return value alone would pass even with the timeout removed.
 *
 * These live in the integration project deliberately — the `unit` project
 * keeps vitest's 5s default (#842), which a timeout test would blow.
 */
describe.skipIf(process.platform === "win32")(
  "doctor probe timeouts (#1075)",
  { timeout: 45_000 },
  () => {
    /** Far longer than any probe bound, but still bounded: `execSync` is
     * synchronous and vitest cannot interrupt it, so an unbounded sleep would
     * hang the run instead of failing it when the timeout is removed. */
    const STUB_SLEEP_SECONDS = 25;

    let stubDir: string;

    beforeEach(() => {
      stubDir = mkdtempSync(join(tmpdir(), "sequant-1075-stub-"));
      for (const bin of ["codex", "opencode"]) {
        const path = join(stubDir, bin);
        // `exec` so the direct child IS sleep: a forked grandchild would
        // outlive the SIGTERM and hold the stdout pipe open past the timeout.
        writeFileSync(path, `#!/bin/sh\nexec sleep ${STUB_SLEEP_SECONDS}\n`);
        chmodSync(path, 0o755);
      }
    });

    afterEach(() => {
      rmSync(stubDir, { recursive: true, force: true });
    });

    /**
     * Run `fn` with the stub dir at the front of `PATH`, always restoring it.
     *
     * Scoped to the callback rather than a file-level hook on purpose: the
     * `runs without crashing` case above spawns the real CLI, which probes
     * both binaries — a leaked stub `PATH` would make it eat three sleeps.
     */
    function withStubPath<T>(fn: () => T): T {
      const prevPath = process.env.PATH;
      process.env.PATH = `${stubDir}:${prevPath ?? ""}`;
      try {
        return fn();
      } finally {
        if (prevPath === undefined) delete process.env.PATH;
        else process.env.PATH = prevPath;
      }
    }

    it("1075 AC-2: a hanging codex makes getCodexVersion() give up, not hang", () => {
      const started = Date.now();
      const version = withStubPath(() => getCodexVersion());
      const elapsedMs = Date.now() - started;

      expect(version).toBeUndefined();
      // 2x PROBE_TIMEOUT_MS (5s) — generous for CI, far under the 25s stub.
      expect(elapsedMs).toBeLessThan(10_000);
    });

    it("1075 AC-3: a hanging `codex login status` makes isCodexAuthenticated() give up, not hang", () => {
      // The env var short-circuits before any subprocess, so it must be unset
      // for this case to reach the probe at all.
      const prevApiKey = process.env.CODEX_API_KEY;
      delete process.env.CODEX_API_KEY;
      try {
        const started = Date.now();
        const authenticated = withStubPath(() => isCodexAuthenticated());
        const elapsedMs = Date.now() - started;

        expect(authenticated).toBe(false);
        // 1.5x AUTH_PROBE_TIMEOUT_MS (10s), under the 25s stub.
        expect(elapsedMs).toBeLessThan(15_000);
      } finally {
        if (prevApiKey !== undefined) process.env.CODEX_API_KEY = prevApiKey;
      }
    });

    it("1075 AC-4: a hanging opencode makes getOpencodeVersion() give up, not hang", () => {
      const started = Date.now();
      const version = withStubPath(() => getOpencodeVersion());
      const elapsedMs = Date.now() - started;

      expect(version).toBeUndefined();
      expect(elapsedMs).toBeLessThan(10_000);
    });
  },
);
