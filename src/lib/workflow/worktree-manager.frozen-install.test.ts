/**
 * Frozen-install guard for worktree dependency installs.
 *
 * A plain `npm install` normalizes and rewrites package-lock.json — observed
 * 2026-07-26 (run #814): local npm 10 stripped the `libc` fields a newer npm
 * had committed, so every freshly provisioned worktree started with an
 * unstaged lockfile. That single dirty file cascaded: `rebaseBeforePR` refused
 * to run ("cannot rebase: You have unstaged changes"), stale worktrees read as
 * having uncommitted work and were never recreated, and chain checkpoints
 * skipped on an out-of-scope dirty file, breaking chain resume (#760).
 *
 * The fix is the same substitution #803 made for merge-check's combined-branch
 * test: install with `ciInstall` ("lockfile-faithful, never rewrites it")
 * instead of `installSilent`. These tests pin that choice at the one site that
 * is directly drivable (`reinstallIfLockfileChanged`) by asserting on the
 * command actually spawned, with `child_process` mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

import { reinstallIfLockfileChanged } from "./worktree-manager.js";
import { PM_CONFIG } from "../stacks.js";

/** Result shape spawnSync callers in worktree-manager expect. */
function ok(stdout = ""): {
  status: number;
  stdout: Buffer;
  stderr: Buffer;
} {
  return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.from("") };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe("reinstallIfLockfileChanged uses a frozen install", () => {
  it("spawns `npm ci`, not `npm install`, when the rebase changed the lockfile", () => {
    // First spawnSync call is the `git diff --name-only` lockfile probe —
    // report package-lock.json as changed so the install path is reached.
    // Every subsequent call (the install itself) succeeds.
    spawnSyncMock
      .mockReturnValueOnce(ok("package-lock.json\n"))
      .mockReturnValue(ok());

    const result = reinstallIfLockfileChanged("/tmp/wt", "npm", false);

    expect(result).toBe(true);
    const installCall = spawnSyncMock.mock.calls.find(([cmd]) => cmd !== "git");
    expect(installCall, "no install command was spawned").toBeDefined();
    const [cmd, args] = installCall!;
    expect([cmd, ...args].join(" ")).toBe("npm ci");
    // The defining property: the frozen command is NOT the rewriting one.
    expect([cmd, ...args].join(" ")).not.toBe(PM_CONFIG.npm.installSilent);
  });

  it("does not spawn any install when the lockfile is unchanged", () => {
    // All git diff probes report no lockfile change.
    spawnSyncMock.mockReturnValue(ok(""));

    const result = reinstallIfLockfileChanged("/tmp/wt", "npm", false);

    expect(result).toBe(false);
    const nonGit = spawnSyncMock.mock.calls.filter(([cmd]) => cmd !== "git");
    expect(nonGit).toHaveLength(0);
  });
});

describe("PM_CONFIG frozen-install invariants", () => {
  it("every node package manager's ciInstall differs from its rewriting install", () => {
    // For node PMs the frozen variant must be a genuinely different command —
    // if a future edit points ciInstall back at a rewriting install, the
    // provisioning fix silently evaporates. (Python PMs intentionally mirror
    // installSilent: pip has no lockfile to protect — stacks.ts:118-120.)
    for (const pm of ["npm", "bun", "yarn", "pnpm"] as const) {
      expect(
        PM_CONFIG[pm].ciInstall,
        `${pm}: ciInstall must not be the rewriting install`,
      ).not.toBe(PM_CONFIG[pm].installSilent);
      expect(PM_CONFIG[pm].ciInstall).not.toBe(PM_CONFIG[pm].install);
    }
  });
});
