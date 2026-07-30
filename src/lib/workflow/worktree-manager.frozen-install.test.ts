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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

import {
  reinstallIfLockfileChanged,
  installWorktreeDeps,
} from "./worktree-manager.js";
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

describe("installWorktreeDeps surfaces a failed provisioning install (#846)", () => {
  it("warns naming the failure when `npm ci` exits non-zero (no lockfile)", () => {
    // A repo with no lockfile makes `npm ci` hard-fail: status 1, message on
    // stderr, no node_modules. Assert the failure is reported, not swallowed.
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(
        "npm error The `npm ci` command can only install with an existing package-lock.json",
      ),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const ok = installWorktreeDeps("/tmp/wt", "npm", false);

    expect(ok).toBe(false); // warn-and-continue, not throw (AC-1)
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output, "no warning was emitted").toMatch(
      /Dependency install failed/,
    );
    expect(output).toContain("package-lock.json"); // stderr surfaced (AC-1)
    expect(output).toContain("npm ci"); // resolved command for rerun (AC-2)

    logSpy.mockRestore();
  });

  it("still names the command when stderr is empty", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const ok = installWorktreeDeps("/tmp/wt", "npm", false);

    expect(ok).toBe(false);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("npm ci"); // command alone is enough to act on

    logSpy.mockRestore();
  });

  it("returns true and warns nothing on a successful install", () => {
    spawnSyncMock.mockReturnValue(ok());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = installWorktreeDeps("/tmp/wt", "npm", false);

    expect(result).toBe(true);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toMatch(/Dependency install failed/);

    logSpy.mockRestore();
  });
});

describe("manifest-less worktrees detect the package manager (#870)", () => {
  // These are the gate tests for #870. Both functions used to resolve the PM as
  // `(packageManager as keyof typeof PM_CONFIG) || "npm"`, so a worktree whose
  // manifest recorded nothing was installed with `npm ci` even on a pnpm
  // project — while new-feature.sh, PM-aware since #847, detected pnpm from the
  // lockfile and ran `pnpm install --frozen-lockfile`. Reverting either call
  // site to the bare `|| "npm"` must fail here.
  //
  // A real temp dir (not a mocked `fs`) backs the detection: only
  // `child_process` is mocked in this file, and detectPackageManagerSync reads
  // the filesystem via existsSync.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sequant-870-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The install command actually spawned, as a single string. */
  function spawnedInstall(): string {
    const call = spawnSyncMock.mock.calls.find(([cmd]) => cmd !== "git");
    expect(call, "no install command was spawned").toBeDefined();
    const [cmd, args] = call!;
    return [cmd, ...args].join(" ");
  }

  it("installWorktreeDeps runs pnpm's frozen install on a manifest-less pnpm worktree", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    spawnSyncMock.mockReturnValue(ok());

    expect(installWorktreeDeps(dir, undefined, false)).toBe(true);

    // AC-2: byte-identical to new-feature.sh's `pnpm)` branch of
    // pm_frozen_install, because both read PM_CONFIG.pnpm.ciInstall.
    expect(spawnedInstall()).toBe("pnpm install --frozen-lockfile");
    expect(spawnedInstall()).not.toBe(PM_CONFIG.npm.ciInstall);
  });

  it("reinstallIfLockfileChanged runs yarn's frozen install on a manifest-less yarn worktree", () => {
    writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
    // First spawnSync is the `git diff` lockfile probe — report a change so the
    // install path is reached; the install itself then succeeds.
    spawnSyncMock.mockReturnValueOnce(ok("yarn.lock\n")).mockReturnValue(ok());

    expect(reinstallIfLockfileChanged(dir, undefined, false)).toBe(true);

    // Classic, not berry: this fixture's content is literally Yarn 1's
    // `# yarn lockfile v1` header, and #871 (which landed after #870) resolves
    // the frozen install per yarn major. The assertion read `--immutable` when
    // #870 was written, because yarn then had one hardcoded spelling for both
    // majors. So this test now pins the two features COMPOSING: #870 answers
    // which manager from the lockfile when the manifest is silent, #871 answers
    // which of that manager's commands from the same tree.
    expect(spawnedInstall()).toBe("yarn install --frozen-lockfile");
    expect(spawnedInstall()).not.toBe(PM_CONFIG.npm.ciInstall);
  });

  it("a declared manager still wins over the worktree's lockfile", () => {
    // The manifest is the more specific signal when it exists; detection is
    // only the fallback. Guards against over-correcting into always-detect.
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    spawnSyncMock.mockReturnValue(ok());

    expect(installWorktreeDeps(dir, "bun", false)).toBe(true);

    expect(spawnedInstall()).toBe(PM_CONFIG.bun.ciInstall);
  });

  it("a manifest-less worktree with no lockfile still falls back to npm", () => {
    // detectPackageManagerSync's own npm default — behavior here is unchanged
    // from before #870, and `npm ci` failing loudly is the #846 path.
    spawnSyncMock.mockReturnValue(ok());

    expect(installWorktreeDeps(dir, undefined, false)).toBe(true);

    expect(spawnedInstall()).toBe("npm ci");
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

// Yarn 1 vs Yarn 2+ at both TypeScript install sites — issue #871.
//
// `PM_CONFIG.yarn.ciInstall` is berry-only (`--immutable`); Yarn 1 rejects it.
// Both sites must therefore resolve the command against the worktree they are
// installing into, not read it straight off PM_CONFIG. Real tmpdir fixtures are
// used because only `child_process` is mocked here — `detectYarnMajor` reads the
// filesystem, which is exactly the behavior under test.
describe("yarn major is resolved per worktree (#871)", () => {
  function yarnWorktree(lockContents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-yarn-major-"));
    writeFileSync(join(dir, "yarn.lock"), lockContents);
    return dir;
  }

  const YARN_1_LOCK = "# yarn lockfile v1\n";
  const BERRY_LOCK = "__metadata:\n  version: 8\n";

  /** The install command spawned by the call under test. */
  function spawnedInstall(): string {
    const call = spawnSyncMock.mock.calls.find(([cmd]) => cmd !== "git");
    expect(call, "no install command was spawned").toBeDefined();
    const [cmd, args] = call!;
    return [cmd, ...args].join(" ");
  }

  it("installWorktreeDeps runs the classic frozen install in a Yarn 1 worktree", () => {
    const wt = yarnWorktree(YARN_1_LOCK);
    try {
      spawnSyncMock.mockReturnValue(ok());

      expect(installWorktreeDeps(wt, "yarn", false)).toBe(true);
      expect(spawnedInstall()).toBe("yarn install --frozen-lockfile");
      // The bug: `--immutable` is what Yarn 1 errors out on.
      expect(spawnedInstall()).not.toContain("--immutable");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("installWorktreeDeps keeps berry's frozen install in a Yarn 2+ worktree", () => {
    const wt = yarnWorktree(BERRY_LOCK);
    try {
      spawnSyncMock.mockReturnValue(ok());

      expect(installWorktreeDeps(wt, "yarn", false)).toBe(true);
      expect(spawnedInstall()).toBe(PM_CONFIG.yarn.ciInstall);
      expect(spawnedInstall()).toBe("yarn install --immutable");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("reinstallIfLockfileChanged resolves the same way in a Yarn 1 worktree", () => {
    const wt = yarnWorktree(YARN_1_LOCK);
    try {
      // First spawnSync is the git lockfile probe; report yarn.lock changed.
      spawnSyncMock
        .mockReturnValueOnce(ok("yarn.lock\n"))
        .mockReturnValue(ok());

      expect(reinstallIfLockfileChanged(wt, "yarn", false)).toBe(true);
      expect(spawnedInstall()).toBe("yarn install --frozen-lockfile");
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("names the resolved classic command in the failure warning", () => {
    const wt = yarnWorktree(YARN_1_LOCK);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      spawnSyncMock.mockReturnValue({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("error Unknown argument: immutable"),
      });

      expect(installWorktreeDeps(wt, "yarn", false)).toBe(false);
      // A warning naming berry's command would send a Yarn 1 user off to rerun
      // the very command that just failed.
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("yarn install --frozen-lockfile");
      expect(output).not.toContain("--immutable");
    } finally {
      logSpy.mockRestore();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
