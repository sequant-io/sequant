/**
 * CLI integration tests for the `sequant locks` subcommands (#625).
 *
 * Spawns the actual built `dist/bin/cli.js` so the contracts exercised here
 * match what /fullsolve and /assess SKILL.md bash blocks invoke. These
 * complement the LockManager unit tests by catching surface-level
 * regressions (exit codes, JSON shapes, flag wiring) that wouldn't show up
 * when calling the in-process LockManager directly.
 *
 * Test scope:
 *   - acquire → second-acquire-blocked → release → re-acquire
 *   - check (free vs held: exit 0 vs 1)
 *   - check-batch (text + json + empty + orchestrator no-op)
 *   - --force --signal-other --skip-pid-check takeover of a skill lock
 *   - SEQUANT_ORCHESTRATOR no-op surface for every subcommand
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_PATH = resolve(REPO_ROOT, "dist/bin/cli.js");

function runCli(
  args: string[],
  options: { env?: Record<string, string>; orchestrator?: boolean } = {},
): SpawnSyncReturns<string> {
  const env = {
    ...process.env,
    SEQUANT_LOCKS_DIR: locksDir,
    SEQUANT_ORCHESTRATOR: options.orchestrator ? "1" : "",
    ...options.env,
  };
  return spawnSync("node", [CLI_PATH, "locks", ...args], {
    encoding: "utf-8",
    env,
  });
}

let locksDir: string;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `dist/bin/cli.js not found at ${CLI_PATH}. Run 'npm run build' first.`,
    );
  }
});

beforeEach(() => {
  locksDir = mkdtempSync(join(tmpdir(), "sequant-cli-int-"));
});

afterEach(() => {
  rmSync(locksDir, { recursive: true, force: true });
});

describe("sequant locks acquire / release / check", () => {
  it("acquire → second-acquire-blocked → release-from-different-PID → check-free", () => {
    // First acquire from the test process's child.
    const first = runCli([
      "acquire",
      "42",
      "--command=/fullsolve 42",
      "--skip-pid-check",
    ]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("✓ Acquired lock for #42");
    expect(existsSync(join(locksDir, "42.lock"))).toBe(true);

    // Second acquire from a fresh subprocess (different PID, same host).
    const second = runCli([
      "acquire",
      "42",
      "--command=/fullsolve 42 second",
      "--skip-pid-check",
    ]);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("Issue #42 is being worked on by PID");
    expect(second.stderr).toContain("Use --force to take over");

    // check (held) → exit 1.
    const checkHeld = runCli(["check", "42"]);
    expect(checkHeld.status).toBe(1);
    expect(checkHeld.stdout).toContain("Issue #42 is being worked on");

    // Release from yet another fresh subprocess (cross-PID release works
    // because the lock was acquired with --skip-pid-check).
    const release = runCli(["release", "42"]);
    expect(release.status).toBe(0);
    expect(release.stdout).toContain("✓ Released lock for #42");
    expect(existsSync(join(locksDir, "42.lock"))).toBe(false);

    // check (free) → exit 0.
    const checkFree = runCli(["check", "42"]);
    expect(checkFree.status).toBe(0);
    expect(checkFree.stdout).toContain("#42 is not locked");
  });

  it("release is idempotent — calling on a free lock prints 'No releasable lock'", () => {
    const result = runCli(["release", "999"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No releasable lock for #999");
  });

  it("check --json returns structured JSON", () => {
    runCli(["acquire", "50", "--command=test", "--skip-pid-check"]);

    const held = runCli(["check", "50", "--json"]);
    expect(held.status).toBe(1);
    const heldData = JSON.parse(held.stdout);
    expect(heldData).toMatchObject({
      issue: 50,
      locked: true,
      holder: {
        command: "test",
        skipPidCheck: true,
      },
    });

    runCli(["release", "50"]);
    const free = runCli(["check", "50", "--json"]);
    expect(free.status).toBe(0);
    expect(JSON.parse(free.stdout)).toEqual({ issue: 50, locked: false });
  });
});

describe("sequant locks check-batch", () => {
  it("text mode emits one warning line per held issue and nothing for free issues", () => {
    runCli(["acquire", "100", "--command=/fullsolve 100", "--skip-pid-check"]);
    runCli(["acquire", "101", "--command=/fullsolve 101", "--skip-pid-check"]);

    const result = runCli(["check-batch", "100", "101", "102", "103"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^⚠ #100 held by PID \d+ on .+ since .+ \(\/fullsolve 100\)$/,
    );
    expect(lines[1]).toMatch(
      /^⚠ #101 held by PID \d+ on .+ since .+ \(\/fullsolve 101\)$/,
    );
  });

  it("text mode emits NOTHING when no issues are held", () => {
    const result = runCli(["check-batch", "200", "201"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("json mode emits { warnings: [], checked: N } when nothing held", () => {
    const result = runCli(["check-batch", "300", "301", "--json"]);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toEqual({ warnings: [], checked: 2 });
  });

  it("rejects invalid issue numbers with exit code 2", () => {
    const result = runCli(["check-batch", "abc", "100"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid issue number: abc");
  });
});

describe("sequant locks acquire --force --signal-other --skip-pid-check (skill takeover)", () => {
  it("takes over an existing skill-shell lock; signal-other prints 'cross-host holder' for cross-host holder", () => {
    // Pre-write a skill lock as if a prior /fullsolve had acquired it and
    // its shell already exited (the canonical skipPidCheck scenario).
    //
    // The hostname is intentionally a sentinel non-host string so
    // signalOther's cross-host short-circuit returns { sent: false,
    // reason: "cross-host" } WITHOUT invoking process.kill on PID 9999.
    // Previously this used os.hostname() with pid: 9999, which assumed
    // PID 9999 was dead — on a busy CI runner PID 9999 can be a live
    // sibling/ancestor process, and SIGTERMing it killed the CLI mid-spawn
    // → result.status === null (#633).
    //
    // Since #637 the CLI distinguishes each refusal branch in its log line
    // via the discriminated `reason` returned by signalOther; this test
    // anchors on the cross-host wording so a future refactor that
    // accidentally took a different branch would fail loudly.
    writeFileSync(
      join(locksDir, "77.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "definitely-not-this-host",
        startedAt: new Date().toISOString(),
        command: "/fullsolve 77 (prior)",
        skipPidCheck: true,
      }),
    );

    const result = runCli([
      "acquire",
      "77",
      "--command=/fullsolve 77 (takeover)",
      "--skip-pid-check",
      "--force",
      "--signal-other",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ Acquired lock for #77 (forced)");
    // signal-other should report cross-host — anchored on the full
    // "(cross-host holder)" suffix so a future refactor that accidentally
    // takes the "Signaled ..." (sent) branch or a different refusal branch
    // would fail loudly (#637).
    expect(result.stdout).toMatch(
      /Could not signal PID 9999 for #77 \(cross-host holder\)/,
    );

    // The lock file now reflects the new acquirer with the new command label
    // and skipPidCheck still set (we passed --skip-pid-check).
    const after = JSON.parse(readFileSync(join(locksDir, "77.lock"), "utf-8"));
    expect(after.pid).not.toBe(9999);
    expect(after.command).toBe("/fullsolve 77 (takeover)");
    expect(after.skipPidCheck).toBe(true);
  });

  it("--force without --signal-other does NOT print the signal line", () => {
    // Same sentinel-hostname pattern as the sibling test above (#633), so a
    // future edit that adds --signal-other here can't regress the flake.
    writeFileSync(
      join(locksDir, "88.lock"),
      JSON.stringify({
        pid: 9999,
        hostname: "definitely-not-this-host",
        startedAt: new Date().toISOString(),
        command: "old",
        skipPidCheck: true,
      }),
    );

    const result = runCli([
      "acquire",
      "88",
      "--command=takeover",
      "--skip-pid-check",
      "--force",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("✓ Acquired lock for #88 (forced)");
    expect(result.stdout).not.toContain("Signaled");
    expect(result.stdout).not.toContain("Could not signal");
  });
});

describe("sequant locks * (orchestrator no-op)", () => {
  it("acquire is no-op and exits 0 without writing a file", () => {
    const result = runCli(
      ["acquire", "999", "--command=x", "--skip-pid-check"],
      { orchestrator: true },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Lock operations are disabled");
    expect(existsSync(join(locksDir, "999.lock"))).toBe(false);
  });

  it("check --json returns { locked: false, orchestratorMode: true }", () => {
    const result = runCli(["check", "999", "--json"], { orchestrator: true });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      locked: false,
      orchestratorMode: true,
    });
  });

  it("release --json returns { released: false, orchestratorMode: true }", () => {
    const result = runCli(["release", "999", "--json"], {
      orchestrator: true,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      issue: 999,
      released: false,
      orchestratorMode: true,
    });
  });

  it("check-batch --json returns { warnings: [], orchestratorMode: true, checked: 0 }", () => {
    const result = runCli(["check-batch", "1", "2", "3", "--json"], {
      orchestrator: true,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      warnings: [],
      orchestratorMode: true,
      checked: 0,
    });
  });
});
