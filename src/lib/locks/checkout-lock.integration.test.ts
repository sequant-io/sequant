/**
 * Integration tests for the checkout-scoped lock (#901).
 *
 * These drive the REAL `.claude/hooks/pre-tool.sh` as a subprocess, because the
 * hook — not the TypeScript — is what makes the lock binding. The racing actor
 * in the incident that motivated this issue was an agent's `git checkout` Bash
 * command; sequant's own TS mutates git almost exclusively via `git -C
 * <worktree>`. A test that only exercised `CheckoutLock` would assert the part
 * that was never in the loop.
 *
 * AC-2: two sessions, different issues, one checkout — the second is refused
 *       with a message naming the holder and its issue.
 * AC-3: the refusal says how to proceed.
 * AC-7: this file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir, hostname } from "os";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/lib/locks -> repo root */
const REPO_ROOT = resolve(HERE, "../../..");
const HOOK = join(REPO_ROOT, ".claude/hooks/pre-tool.sh");

const HOLDER_SESSION = "session-AAA";
const OTHER_SESSION = "session-BBB";
const HOLDER_ISSUE = 23;
const BLOCKED_ISSUE = 10;

let checkout: string;

/**
 * Hermetic git: no user config, no signing, no hooks. Mirrors the repo's
 * global-setup convention so a developer's `commit.gpgsign=true` cannot break
 * these fixtures.
 */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=sequant-test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

/**
 * A REAL main checkout — the guard resolves the command's working directory
 * with `git rev-parse --show-toplevel`, so a hand-made `.git` directory would
 * not exercise the real path.
 */
function makeMainCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "sequant-checkout-"));
  git(dir, "init", "-q", "-b", "main", ".");
  mkdirSync(join(dir, ".sequant/locks"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function writeCheckoutLock(
  dir: string,
  overrides: Record<string, unknown> = {},
): void {
  const payload = {
    pid: 4711,
    hostname: hostname(),
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    command: `/fullsolve ${HOLDER_ISSUE}`,
    issue: HOLDER_ISSUE,
    sessionId: HOLDER_SESSION,
    skipPidCheck: true,
    ...overrides,
  };
  writeFileSync(
    join(dir, ".sequant/locks/checkout.lock"),
    JSON.stringify(payload, null, 2),
  );
}

interface RunOpts {
  command: string;
  sessionId?: string;
  projectDir?: string;
  /**
   * The shell cwd the command runs in — the `cwd` field of Claude Code's
   * PreToolUse envelope. Defaults to the checkout under test.
   *
   * This is deliberately independent of `projectDir` (CLAUDE_PROJECT_DIR).
   * In a real session the two DIVERGE: the project dir stays pinned to the
   * main checkout while the agent's shell moves into a worktree. An earlier
   * version of these tests set them together, which hid a guard that blocked
   * legitimate in-worktree work.
   */
  cwd?: string;
  env?: Record<string, string>;
}

function runHook(opts: RunOpts): { status: number; stderr: string } {
  const payload: Record<string, unknown> = {
    tool_name: "Bash",
    tool_input: { command: opts.command },
    cwd: opts.cwd ?? checkout,
  };
  if (opts.sessionId) payload.session_id = opts.sessionId;

  const result = spawnSync("bash", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: opts.projectDir ?? checkout,
      // Keep the hook's own logging out of the user's real log dir.
      CLAUDE_PLUGIN_DATA: join(checkout, ".hooklogs"),
      CLAUDE_HOOKS_DISABLED: "",
      SEQUANT_ORCHESTRATOR: "",
      SEQUANT_ISSUE: "",
      ...opts.env,
    },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

beforeEach(() => {
  checkout = makeMainCheckout();
});

afterEach(() => {
  rmSync(checkout, { recursive: true, force: true });
});

describe("AC-2: two sessions, different issues, one checkout", () => {
  it("refuses the second session's branch-mutating git", () => {
    writeCheckoutLock(checkout);

    const { status, stderr } = runHook({
      command: `git checkout feature/${BLOCKED_ISSUE}-something`,
      sessionId: OTHER_SESSION,
    });

    expect(status).toBe(2);
    expect(stderr).toContain("HOOK_BLOCKED: Checkout held by another session");
  });

  it("names the holding session and its issue in the refusal", () => {
    writeCheckoutLock(checkout);

    const { stderr } = runHook({
      command: `git checkout feature/${BLOCKED_ISSUE}-something`,
      sessionId: OTHER_SESSION,
    });

    expect(stderr).toContain(`#${HOLDER_ISSUE}`);
    expect(stderr).toContain("4711");
    expect(stderr).toContain(hostname());
    expect(stderr).toContain(`/fullsolve ${HOLDER_ISSUE}`);
  });

  it("lets the HOLDING session through (no self-block)", () => {
    writeCheckoutLock(checkout);

    const { status } = runHook({
      command: `git checkout feature/${HOLDER_ISSUE}-something`,
      sessionId: HOLDER_SESSION,
    });

    expect(status).toBe(0);
  });

  it("identifies the holder by SEQUANT_ISSUE when no session id is present", () => {
    writeCheckoutLock(checkout, { sessionId: undefined });

    const held = runHook({
      command: "git checkout main",
      env: { SEQUANT_ISSUE: String(HOLDER_ISSUE) },
    });
    expect(held.status).toBe(0);

    const foreign = runHook({
      command: "git checkout main",
      env: { SEQUANT_ISSUE: String(BLOCKED_ISSUE) },
    });
    expect(foreign.status).toBe(2);
  });

  it.each([
    "git switch main",
    "git reset --soft HEAD~1",
    "git rebase main",
    "git merge main",
    "git cherry-pick abc123",
  ])("refuses %s", (command) => {
    writeCheckoutLock(checkout);
    expect(runHook({ command, sessionId: OTHER_SESSION }).status).toBe(2);
  });
});

describe("AC-3: the refusal is actionable", () => {
  it("names a worktree to use instead and how to clear a stale holder", () => {
    writeCheckoutLock(checkout);

    const { stderr } = runHook({
      command: "git checkout main",
      sessionId: OTHER_SESSION,
    });

    expect(stderr).toContain("worktrees/feature/");
    expect(stderr).toContain("new-feature.sh");
    expect(stderr).toContain("git -C <worktree>");
    expect(stderr).toContain("sequant locks checkout clear");
  });
});

describe("the guard does not fire where it must not", () => {
  it("allows git targeting another tree with -C", () => {
    writeCheckoutLock(checkout);
    expect(
      runHook({
        command: "git -C ../worktrees/feature/10-x checkout main",
        sessionId: OTHER_SESSION,
      }).status,
    ).toBe(0);
  });

  it.each(["git checkout -- src/foo.ts", "git checkout main -- src/foo.ts"])(
    "allows path-restore form: %s",
    (command) => {
      writeCheckoutLock(checkout);
      expect(runHook({ command, sessionId: OTHER_SESSION }).status).toBe(0);
    },
  );

  it("allows non-mutating git", () => {
    writeCheckoutLock(checkout);
    expect(
      runHook({ command: "git status", sessionId: OTHER_SESSION }).status,
    ).toBe(0);
  });

  it("allows when no checkout lock exists", () => {
    expect(
      runHook({ command: "git checkout main", sessionId: OTHER_SESSION })
        .status,
    ).toBe(0);
  });

  it("does not block a command running inside a REAL linked worktree", () => {
    // The guard's worst failure mode. CLAUDE_PROJECT_DIR stays pinned to the
    // main checkout while the agent's shell sits in a worktree, so a guard
    // keyed on the project dir blocks exactly the work the lock is trying to
    // push people toward. Regression test: project dir and cwd DIVERGE here,
    // as they do in a real session.
    writeCheckoutLock(checkout);
    const wt = join(checkout, "..", `wt-${Date.now() % 100000}`);
    try {
      git(checkout, "worktree", "add", "-q", "-b", "feature/10-x", wt);

      const { status } = runHook({
        command: "git checkout main",
        sessionId: OTHER_SESSION,
        projectDir: checkout, // <- main checkout, as Claude Code sets it
        cwd: wt, //              <- but the shell is in the worktree
      });

      expect(status).toBe(0);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], {
        cwd: checkout,
      });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("still blocks when the shell is in the main checkout", () => {
    // The other half of the divergence: same project dir, cwd IS the main
    // checkout, so the guard must fire. Without this, the fix above could be
    // "always allow" and still pass.
    writeCheckoutLock(checkout);

    expect(
      runHook({
        command: "git checkout main",
        sessionId: OTHER_SESSION,
        projectDir: checkout,
        cwd: checkout,
      }).status,
    ).toBe(2);
  });

  it("honors a leading `cd <worktree> &&` in the command", () => {
    writeCheckoutLock(checkout);
    const wt = join(checkout, "..", `wtcd-${Date.now() % 100000}`);
    try {
      git(checkout, "worktree", "add", "-q", "-b", "feature/11-x", wt);

      expect(
        runHook({
          command: `cd ${wt} && git checkout main`,
          sessionId: OTHER_SESSION,
          cwd: checkout, // shell starts in main, but cds into the worktree
        }).status,
      ).toBe(0);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], {
        cwd: checkout,
      });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("AC-4: stale recovery — an abandoned holder cannot wedge the checkout", () => {
  it("blocks a holder inside the age ceiling", () => {
    writeCheckoutLock(checkout);
    expect(
      runHook({ command: "git checkout main", sessionId: OTHER_SESSION })
        .status,
    ).toBe(2);
  });

  it("stands down for a holder past the default 24h ceiling", () => {
    writeCheckoutLock(checkout, {
      startedAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    });

    expect(
      runHook({ command: "git checkout main", sessionId: OTHER_SESSION })
        .status,
    ).toBe(0);
  });

  it("honors SEQUANT_MAX_LOCK_AGE_MS", () => {
    writeCheckoutLock(checkout);

    expect(
      runHook({
        command: "git checkout main",
        sessionId: OTHER_SESSION,
        env: { SEQUANT_MAX_LOCK_AGE_MS: "1" },
      }).status,
    ).toBe(0);
  });

  it("parses startedAt as UTC, not local time", () => {
    // Regression guard. BSD `date -j -f` parses in LOCAL time; without TZ=UTC
    // a lock written 12 minutes ago yields a NEGATIVE age west of UTC, so it
    // never crosses any ceiling and wedges the tree forever. A 25h-old holder
    // must read as stale in every timezone.
    writeCheckoutLock(checkout, {
      startedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
    });

    for (const TZ of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      expect(
        runHook({
          command: "git checkout main",
          sessionId: OTHER_SESSION,
          env: { TZ },
        }).status,
        `expected stale (allow) in TZ=${TZ}`,
      ).toBe(0);
    }
  });
});

describe("AC-4: hook/TypeScript staleness parity", () => {
  // The hook re-implements `classifyStaleness` in shell. #871 is the standing
  // lesson that a shell transcription of TS logic drifts, and the repo's drift
  // guard only compares literal strings — it cannot see a semantic divergence.
  // So pin the two to the same verdict across the branch matrix instead.
  //
  // `stale === true` means recovery should kick in: the TypeScript re-acquires,
  // and the hook stands down (exit 0). `stale === false` means both hold the
  // tree: the TypeScript refuses, and the hook blocks (exit 2).
  const HOUR = 60 * 60_000;
  const cases: Array<{
    name: string;
    ageMs: number;
    skipPidCheck: boolean;
    pidAlive: boolean;
    sameHost: boolean;
    stale: boolean;
  }> = [
    // Rule 0 — absolute ceiling wins over a live PID (#856).
    {
      name: "26h old, live PID, same host",
      ageMs: 26 * HOUR,
      skipPidCheck: false,
      pidAlive: true,
      sameHost: true,
      stale: true,
    },
    // Rule 1 — same-host PID check is authoritative.
    {
      name: "1h old, dead PID, same host",
      ageMs: HOUR,
      skipPidCheck: false,
      pidAlive: false,
      sameHost: true,
      stale: true,
    },
    {
      name: "1h old, live PID, same host",
      ageMs: HOUR,
      skipPidCheck: false,
      pidAlive: true,
      sameHost: true,
      stale: false,
    },
    // Rule 2 — skipPidCheck falls back to the 6h skill TTL.
    {
      name: "1h old, skipPidCheck",
      ageMs: HOUR,
      skipPidCheck: true,
      pidAlive: false,
      sameHost: true,
      stale: false,
    },
    {
      name: "7h old, skipPidCheck",
      ageMs: 7 * HOUR,
      skipPidCheck: true,
      pidAlive: false,
      sameHost: true,
      stale: true,
    },
    // Rule 2 — cross-host uses the stricter 2h TTL.
    {
      name: "1h old, cross-host",
      ageMs: HOUR,
      skipPidCheck: false,
      pidAlive: true,
      sameHost: false,
      stale: false,
    },
    {
      name: "3h old, cross-host",
      ageMs: 3 * HOUR,
      skipPidCheck: false,
      pidAlive: true,
      sameHost: false,
      stale: true,
    },
  ];

  it.each(cases)(
    "$name -> stale=$stale in BOTH the hook and classifyStaleness",
    async ({ ageMs, skipPidCheck, pidAlive, sameHost, stale }) => {
      // A PID that is genuinely alive (this process) or genuinely dead.
      const pid = pidAlive ? process.pid : 2_147_483_600;
      const host = sameHost ? hostname() : "some-other-host";
      const startedAt = new Date(Date.now() - ageMs).toISOString();

      // --- hook verdict -------------------------------------------------
      writeCheckoutLock(checkout, {
        pid,
        hostname: host,
        startedAt,
        sessionId: HOLDER_SESSION,
        ...(skipPidCheck
          ? { skipPidCheck: true }
          : { skipPidCheck: undefined }),
      });
      const hookStale =
        runHook({ command: "git checkout main", sessionId: OTHER_SESSION })
          .status === 0;

      // --- TypeScript verdict -------------------------------------------
      const { classifyStaleness } = await import("./lock-manager.js");
      const tsStale =
        classifyStaleness({
          holder: {
            pid,
            hostname: host,
            startedAt,
            command: "x",
            ...(skipPidCheck ? { skipPidCheck: true } : {}),
          },
          myHostname: hostname(),
          now: Date.now(),
          staleAgeMs: 2 * HOUR,
          skillLockTtlMs: 6 * HOUR,
          maxLockAgeMs: 24 * HOUR,
          isPidAlive: () => pidAlive,
        }) !== null;

      expect(tsStale, "classifyStaleness disagrees with the expectation").toBe(
        stale,
      );
      expect(hookStale, "hook disagrees with classifyStaleness").toBe(tsStale);
    },
  );
});

describe("AC-2/AC-7: genuinely concurrent processes, one checkout", () => {
  // Everything above simulates the second session by writing a lock file.
  // That exercises the guard but not the claim itself: that two real,
  // concurrently-racing processes cannot both come away holding the tree.
  // These spawn the built CLI for real and let the kernel arbitrate.
  const CLI = join(REPO_ROOT, "dist/bin/cli.js");

  /**
   * Must use async `spawn`, NOT `spawnSync`. `spawnSync` blocks the event
   * loop, so `Promise.all` over it would run the children strictly one after
   * another -- the processes would never overlap and the "race" would be
   * theatre. With `spawn` they are genuinely in flight together and the
   * kernel arbitrates the O_CREAT|O_EXCL create.
   */
  function acquireAsync(issue: number, sessionId: string, locksDir: string) {
    return new Promise<{ acquired: boolean; issue: number }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          CLI,
          "locks",
          "checkout",
          "acquire",
          `--issue=${issue}`,
          `--session-id=${sessionId}`,
          "--command=/fullsolve",
          "--skip-pid-check",
          "--json",
        ],
        {
          env: {
            ...process.env,
            SEQUANT_LOCKS_DIR: locksDir,
            SEQUANT_ORCHESTRATOR: "",
          },
        },
      );
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.on("close", () => {
        let acquired = false;
        try {
          acquired = JSON.parse(stdout.trim()).acquired === true;
        } catch {
          acquired = false;
        }
        resolve({ acquired, issue });
      });
    });
  }

  it("exactly one of six racing sessions wins the checkout", async () => {
    const locksDir = join(checkout, ".sequant/locks");
    const issues = [10, 23, 41, 55, 67, 78];

    const results = await Promise.all(
      issues.map((issue, i) => acquireAsync(issue, `session-${i}`, locksDir)),
    );

    const winners = results.filter((r) => r.acquired);
    expect(winners).toHaveLength(1);

    // And the lock on disk belongs to that winner — not merely "some lock".
    const onDisk = JSON.parse(
      readFileSync(join(locksDir, "checkout.lock"), "utf-8"),
    );
    expect(onDisk.issue).toBe(winners[0].issue);
  });

  it("the loser's refusal names the actual winner", async () => {
    const locksDir = join(checkout, ".sequant/locks");
    const first = await acquireAsync(23, "session-A", locksDir);
    expect(first.acquired).toBe(true);

    const second = spawnSync(
      process.execPath,
      [
        CLI,
        "locks",
        "checkout",
        "acquire",
        "--issue=10",
        "--session-id=session-B",
        "--command=/fullsolve 10",
        "--skip-pid-check",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          SEQUANT_LOCKS_DIR: locksDir,
          SEQUANT_ORCHESTRATOR: "",
        },
      },
    );

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("#23");
    expect(second.stderr).toContain("../worktrees/feature/10-*/");
  });

  it("release hands the checkout to the next session", async () => {
    const locksDir = join(checkout, ".sequant/locks");
    await acquireAsync(23, "session-A", locksDir);

    const released = spawnSync(
      process.execPath,
      [CLI, "locks", "checkout", "release", "--json"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          SEQUANT_LOCKS_DIR: locksDir,
          SEQUANT_ORCHESTRATOR: "",
        },
      },
    );
    expect(JSON.parse(released.stdout.trim()).released).toBe(true);

    const next = await acquireAsync(10, "session-B", locksDir);
    expect(next.acquired).toBe(true);
  });
});

describe("AC-5: orchestrator/MCP mode stands down", () => {
  it("does not block when SEQUANT_ORCHESTRATOR is set", () => {
    writeCheckoutLock(checkout);

    expect(
      runHook({
        command: "git checkout main",
        sessionId: OTHER_SESSION,
        env: { SEQUANT_ORCHESTRATOR: "1" },
      }).status,
    ).toBe(0);
  });
});
