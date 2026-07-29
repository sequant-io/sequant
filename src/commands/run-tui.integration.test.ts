/**
 * Integration tests for `sequant run` TUI flag wiring.
 *
 * #705: the boxed Ink TUI is now the default on a TTY. `--experimental-tui` is
 * retained as a hidden no-op alias (parses, but absent from --help), and
 * `--no-tui` opts out to the line renderer. These tests assert the CLI accepts
 * both flags without parser errors; the tuiEnabled precedence is unit-tested in
 * run-flags.test.ts.
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

const execOptions: ExecSyncOptionsWithStringEncoding = {
  cwd: projectRoot,
  encoding: "utf-8",
  timeout: 15000,
};

// Build handled by vitest globalSetup (vitest.global-setup.ts). Fail loudly if
// it is missing rather than `it.skipIf(!distExists)` (#842 AC-6) — a skip made
// both flag-wiring assertions silently vanish on an unbuilt tree.
beforeAll(() => {
  if (!existsSync(cliPath)) {
    throw new Error(
      `dist/bin/cli.js not found at ${cliPath}. Run 'npm run build' first.`,
    );
  }
});

describe("sequant run TUI flag wiring (#705)", () => {
  it("--experimental-tui is hidden from run --help (no-op alias)", () => {
    const help = execSync(`node ${cliPath} run --help`, execOptions);
    // #705: the TUI is the default, so the alias is hidden. `--no-tui` is the
    // documented opt-out and must appear instead.
    expect(help).not.toMatch(/--experimental-tui/);
    expect(help).toMatch(/--no-tui/);
  });

  it("accepts --experimental-tui without TTY and does not error out (hidden no-op alias)", () => {
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
  });
});
