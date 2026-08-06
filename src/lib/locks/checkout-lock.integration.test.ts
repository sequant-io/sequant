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
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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

/** A directory that looks like a MAIN checkout: `.git` is a directory. */
function makeMainCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "sequant-checkout-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".sequant/locks"), { recursive: true });
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
  env?: Record<string, string>;
}

function runHook(opts: RunOpts): { status: number; stderr: string } {
  const payload: Record<string, unknown> = {
    tool_name: "Bash",
    tool_input: { command: opts.command },
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

  it("does not protect a LINKED worktree (.git is a file there)", () => {
    const wt = mkdtempSync(join(tmpdir(), "sequant-linked-wt-"));
    try {
      writeFileSync(join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      mkdirSync(join(wt, ".sequant/locks"), { recursive: true });
      writeCheckoutLock(wt);

      expect(
        runHook({
          command: "git checkout main",
          sessionId: OTHER_SESSION,
          projectDir: wt,
        }).status,
      ).toBe(0);
    } finally {
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
