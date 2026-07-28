/**
 * #833 AC-3/AC-4 — the numeric-flag validators are actually *wired* to the
 * commands, not merely defined.
 *
 * `cli-flags.test.ts` proves the validator rejects bad input. It cannot prove
 * `bin/cli.ts` passes it to `--timeout`, and a validator that is never attached
 * is exactly the #305 inert-flag failure: it parses, it shows in `--help`, and
 * it does nothing. So these run the real built CLI as a subprocess.
 *
 * Commander runs argument coercion before the action handler, so none of these
 * invocations start a workflow, touch GitHub, or need a worktree — they exit
 * during parsing.
 */

import { spawnSync } from "child_process";
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const cliPath = resolve(projectRoot, "dist/bin/cli.js");

// Build handled by vitest globalSetup (vitest.global-setup.ts)
function runCli(args: string[]) {
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** `[command, flag, bad value, expected message fragment]` */
const REJECTED: Array<[string, string, string, RegExp]> = [
  // AC-3: the two sites named in the issue.
  ["run", "--timeout", "abc", /--timeout expects a whole number of seconds/],
  ["ready", "--timeout", "abc", /--timeout expects a whole number of seconds/],
  // AC-4: `30m` must not be read as 30.
  ["run", "--timeout", "30m", /--timeout expects a whole number of seconds/],
  ["ready", "--timeout", "30m", /--timeout expects a whole number of seconds/],
  // AC-2: 0 has no "no timeout" meaning on either command.
  ["run", "--timeout", "0", /--timeout must be at least 1 second/],
  ["ready", "--timeout", "0", /--timeout must be at least 1 second/],
  // AC-6: siblings whose malformed value was equally load-bearing.
  [
    "run",
    "--max-iterations",
    "abc",
    /--max-iterations expects a whole number of iterations/,
  ],
  ["run", "--concurrency", "3x", /--concurrency expects a whole number/],
  [
    "run",
    "--auto-wait",
    "30m",
    /--auto-wait expects a whole number of minutes/,
  ],
  ["abort", "--grace", "abc", /--grace expects a whole number of seconds/],
  ["ready", "--budget", "10k", /--budget expects a whole number of tokens/],
];

describe("#833 numeric flags are validated at the CLI boundary", () => {
  it.each(REJECTED)(
    "`%s %s %s` is rejected before anything runs",
    (command, flag, badValue, expected) => {
      const { status, output } = runCli([command, "1", flag, badValue]);
      expect(output).toMatch(expected);
      expect(status).not.toBe(0);
    },
  );

  it("echoes the offending value in the error", () => {
    const { output } = runCli(["run", "1", "--timeout", "30m"]);
    expect(output).toMatch(/\(got '30m'\)/);
  });

  // Positive control. Without it the suite would pass just as happily if these
  // flags rejected *every* value, which would be a worse bug than the one being
  // fixed. Each invocation below is chosen to exit without doing real work:
  //
  //   run   — a deliberately bad `--phases` throws during coercion, after the
  //           numeric flag has already been accepted. No workflow starts.
  //   ready — issue #999999 has no worktree, so it exits before any phase.
  //   abort — no running session for #999999, so it exits before any signal.
  it.each([
    [
      "a valid --timeout on run",
      ["run", "1", "--timeout", "60", "--phases", "bogus"],
    ],
    [
      "a valid --max-iterations on run",
      ["run", "1", "--max-iterations", "5", "--phases", "bogus"],
    ],
    [
      "a valid --concurrency on run",
      ["run", "1", "--concurrency", "3", "--phases", "bogus"],
    ],
    [
      "--auto-wait 0, the documented 'off' value (#804)",
      ["run", "1", "--auto-wait", "0", "--phases", "bogus"],
    ],
    [
      "a valid --timeout on ready",
      ["ready", "999999", "--timeout", "60", "--json"],
    ],
    [
      "a valid --budget on ready",
      ["ready", "999999", "--budget", "50000", "--json"],
    ],
    [
      "--grace 0, meaning escalate immediately",
      ["abort", "999999", "--grace", "0", "--json"],
    ],
  ])("accepts %s", (_label, args) => {
    const { output } = runCli(args);
    expect(output).not.toMatch(/expects a whole number/);
    expect(output).not.toMatch(/must be at least/);
  });

  it("the positive control really does exit during parsing, not mid-run", () => {
    // Guards the control above: if `--phases bogus` ever stopped throwing, the
    // `run` cases would start real workflows instead of proving anything.
    const { status, output } = runCli([
      "run",
      "1",
      "--timeout",
      "60",
      "--phases",
      "bogus",
    ]);
    expect(output).toMatch(/Unknown phase 'bogus'/);
    expect(status).not.toBe(0);
  });
});
