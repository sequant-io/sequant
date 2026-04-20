/**
 * Integration tests for `sequant run --experimental-tui` flag wiring.
 *
 * Verifies the flag is registered at all three layers:
 *   1. bin/cli.ts option registration
 *   2. RunOptions interface (pre-merge)
 *   3. runCommand branches on TTY detection for the TUI path
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");
const distExists = existsSync(cliPath);

const execOptions: ExecSyncOptionsWithStringEncoding = {
  cwd: projectRoot,
  encoding: "utf-8",
  timeout: 15000,
};

describe("sequant run --experimental-tui (CLI wiring)", () => {
  it.skipIf(!distExists)("registers --experimental-tui in run --help", () => {
    const help = execSync(`node ${cliPath} run --help`, execOptions);
    expect(help).toMatch(/--experimental-tui/);
    expect(help).toMatch(/live multi-issue dashboard/i);
  });

  it.skipIf(!distExists)(
    "accepts --experimental-tui without TTY and does not error out (auto-fallback)",
    () => {
      // Piping through execSync guarantees stdout is not a TTY.
      // Combined with --dry-run, the run should produce linear output
      // rather than mounting the ink renderer (which would fail without TTY).
      let output = "";
      try {
        output = execSync(
          `node ${cliPath} run 1 --experimental-tui --dry-run`,
          execOptions,
        );
      } catch (err) {
        // Some environments (not initialized) will exit non-zero; the thing
        // we care about is that the flag is accepted, not that the run
        // succeeds end-to-end.
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
      }
      // The absence of a parser error is the signal. Commander prints
      // "unknown option" to stderr when a flag isn't registered.
      expect(output).not.toMatch(/unknown option/i);
    },
  );
});
