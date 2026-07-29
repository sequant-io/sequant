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
      // The error must echo the offending value — "invalid" alone doesn't tell
      // the user which of their flags is wrong.
      expect(output).toContain(`(got '${badValue}')`);
      expect(status).not.toBe(0);
    },
  );

  // Positive control. Without it the suite would pass just as happily if these
  // flags rejected *every* value, which would be a worse bug than the one being
  // fixed. Each invocation is chosen to exit without doing real work:
  //
  //   run   — a deliberately bad `--phases` throws during coercion, after the
  //           numeric flag has already been accepted. No workflow starts.
  //   ready — issue #999999 has no worktree, so it exits before any phase.
  //   abort — no running session for #999999, so it exits before any signal.
  //
  // `reached` is what stops these from passing vacuously. Asserting only the
  // *absence* of a coercion error would stay green if the command started
  // failing earlier for some unrelated reason — the flag would never be parsed
  // at all and the test would still report success. Pinning the specific
  // downstream message proves the run actually got past argument coercion.
  it.each([
    [
      "a valid --timeout on run",
      ["run", "1", "--timeout", "60", "--phases", "bogus"],
      /Unknown phase 'bogus'/,
    ],
    [
      "a valid --max-iterations on run",
      ["run", "1", "--max-iterations", "5", "--phases", "bogus"],
      /Unknown phase 'bogus'/,
    ],
    [
      "a valid --concurrency on run",
      ["run", "1", "--concurrency", "3", "--phases", "bogus"],
      /Unknown phase 'bogus'/,
    ],
    [
      "--auto-wait 0, the documented 'off' value (#804)",
      ["run", "1", "--auto-wait", "0", "--phases", "bogus"],
      /Unknown phase 'bogus'/,
    ],
    [
      "a valid --timeout on ready",
      ["ready", "999999", "--timeout", "60", "--json"],
      /No worktree found for issue #999999/,
    ],
    [
      "a valid --budget on ready",
      ["ready", "999999", "--budget", "50000", "--json"],
      /No worktree found for issue #999999/,
    ],
    [
      "--grace 0, meaning escalate immediately",
      ["abort", "999999", "--grace", "0", "--json"],
      /No relay PID found for #999999/,
    ],
  ])("accepts %s", (_label, args, reached) => {
    const { output } = runCli(args);
    expect(output).not.toMatch(/expects a whole number/);
    expect(output).not.toMatch(/must be at least/);
    // Proves the command got *past* coercion rather than dying before it.
    expect(output).toMatch(reached);
  });
});

/**
 * #845 — the eight numeric options #833 left on bare `parseInt`.
 *
 * These are the end-to-end reproductions from the issue body, run against the
 * real built CLI. Testing them here (not only as unit calls in
 * `cli-flags.test.ts`) is what proves each flag is actually *wired* to its
 * coercion: a unit test on `parseWholeNumber` stays green even if `bin/cli.ts`
 * silently reverts a flag to `parseInt`. Coercion runs during commander's parse
 * phase, so every rejection exits before the action handler — no server binds,
 * no cleanup runs (the AC-2 "fail-open" guarantee for `--max-age`).
 */
describe("#845 the eight migrated flags are validated at the CLI boundary", () => {
  // `[argv, bad value echoed, expected message fragment]`. Values are the exact
  // misparses demonstrated in the issue (`30m`, `1w`, `3100x`, ...).
  const REJECTED_845: Array<[string[], string, RegExp]> = [
    // AC-1: unit-suffixed value rejected with #833's message shape.
    [["status", "999999x"], "999999x", /issue expects a whole number/],
    [["logs", "--last", "30m"], "30m", /--last expects a whole number/],
    [["logs", "--issue", "817x"], "817x", /--issue expects a whole number/],
    [
      ["prompt", "817", "hello", "--wait", "30m"],
      "30m",
      /--wait expects a whole number of seconds/,
    ],
    // AC-2: `--max-age` rejects `1w` instead of silently narrowing to 1 day.
    [
      ["status", "--max-age", "1w"],
      "1w",
      /--max-age expects a whole number of days/,
    ],
    [
      ["state", "clean", "--max-age", "1w"],
      "1w",
      /--max-age expects a whole number of days/,
    ],
    // AC-3: both port flags reject `3100x` rather than binding the truncation.
    [
      ["dashboard", "--port", "3100x"],
      "3100x",
      /--port expects a whole number/,
    ],
    [["serve", "--port", "3199x"], "3199x", /--port expects a whole number/],
  ];

  it.each(REJECTED_845)(
    "`sequant %s` is rejected before anything runs",
    (argv, badValue, expected) => {
      const { status, output } = runCli(argv);
      expect(output).toMatch(expected);
      expect(output).toContain(`(got '${badValue}')`);
      expect(status).not.toBe(0);
    },
  );

  // AC-4: `--wait 0` is the one boundary that changes shape here — `min: 0`,
  // not `parsePositiveSeconds`, because `prompt.ts:259` reads 0 as "don't
  // block". Proven end-to-end: 0 is accepted (no coercion error) and the
  // command reaches its liveness check for a session that doesn't exist.
  it("accepts --wait 0, the documented no-wait value", () => {
    const { output } = runCli(["prompt", "999999", "test", "--wait", "0"]);
    expect(output).not.toMatch(/expects a whole number/);
    expect(output).not.toMatch(/must be at least/);
    expect(output).toMatch(/No relay PID found for #999999/);
  });
});
