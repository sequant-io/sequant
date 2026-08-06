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
