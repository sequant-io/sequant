/**
 * Regression tests for #935 — a signal-driven shutdown must not delete a
 * worktree its own #879 exec-failure message just told the user held their
 * preserved work.
 *
 * These use real git worktrees rather than mocks: the entire claim is about
 * what `git worktree list` reports after the registered cleanup runs, so
 * mocking it out would test nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { ShutdownManager } from "../shutdown.js";
import type { WorktreeInfo } from "./worktree-manager.js";
import {
  cleanupWorktreeOnShutdown,
  registerWorktreeRemovalCleanup,
} from "./worktree-manager.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr?.toString()}`,
    );
  }
}

/** Create a git repo with one commit, isolated from the user's git config. */
function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "init");
}

function listWorktreePaths(repo: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repo,
    stdio: "pipe",
  });
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

describe("run-orchestrator shutdown worktree cleanup (#935)", () => {
  let sandbox: string;
  let repo: string;
  let dirtyPath: string;
  let cleanPath: string;
  let originalCwd: string;

  beforeAll(() => {
    // realpath: on macOS `tmpdir()` returns a `/var/...` path that resolves
    // through a symlink to `/private/var/...` — `git worktree list` reports
    // the resolved form, so an unresolved sandbox path never matches.
    sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), "sequant-935-")));
    repo = path.join(sandbox, "repo");
    initRepo(repo);

    // `git worktree remove` (invoked with no explicit cwd, matching the
    // production call site) resolves against `process.cwd()` — chdir into
    // the fixture repo so it targets it instead of the test runner's cwd.
    originalCwd = process.cwd();
    process.chdir(repo);

    dirtyPath = path.join(sandbox, "dirty-worktree");
    cleanPath = path.join(sandbox, "clean-worktree");
    git(repo, "worktree", "add", "-b", "feature/935-dirty", dirtyPath);
    git(repo, "worktree", "add", "-b", "feature/935-clean", cleanPath);

    // Dirty one has an untracked file — uncommitted work that only exists
    // on disk, exactly what a #879 exec-failure message would name.
    writeFileSync(path.join(dirtyPath, "scratch.txt"), "uncommitted work\n");
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("AC-1: a signal-driven shutdown preserves a dirty worktree and removes a clean one", async () => {
    const logs: string[] = [];
    const shutdown = new ShutdownManager({
      output: () => {},
      errorOutput: () => {},
      exit: () => {},
    });

    const dirtyInfo: WorktreeInfo = {
      issue: 1,
      path: dirtyPath,
      branch: "feature/935-dirty",
      existed: false,
      rebased: false,
    };
    const cleanInfo: WorktreeInfo = {
      issue: 2,
      path: cleanPath,
      branch: "feature/935-clean",
      existed: false,
      rebased: false,
    };

    registerWorktreeRemovalCleanup(shutdown, 1, dirtyInfo, (msg) =>
      logs.push(msg),
    );
    registerWorktreeRemovalCleanup(shutdown, 2, cleanInfo, (msg) =>
      logs.push(msg),
    );

    await shutdown.gracefulShutdown("SIGTERM");

    const remaining = listWorktreePaths(repo);
    expect(remaining).toContain(dirtyPath);
    expect(remaining).not.toContain(cleanPath);

    // AC-2: the message for the preserved (dirty) case names a path that
    // still exists on disk.
    const preservedMsg = logs.find((m) => m.includes("preserved"));
    expect(preservedMsg).toContain(dirtyPath);
    expect(existsSync(dirtyPath)).toBe(true);

    // The message for the removed (clean) case names the branch, not the
    // (now-gone) path.
    const removedMsg = logs.find((m) => m.includes("removed"));
    expect(removedMsg).toContain("feature/935-clean");
    expect(removedMsg).not.toContain(cleanPath);
  });

  it("AC-2: a non-signal (programmatic) teardown always removes, even a dirty worktree, and names the branch", async () => {
    const again = path.join(sandbox, "dirty-worktree-2");
    git(repo, "worktree", "add", "-b", "feature/935-dirty-2", again);
    writeFileSync(path.join(again, "scratch.txt"), "more uncommitted work\n");

    const logs: string[] = [];
    const info: WorktreeInfo = {
      issue: 3,
      path: again,
      branch: "feature/935-dirty-2",
      existed: false,
      rebased: false,
    };

    // abort = null: a programmatic teardown, not a real signal.
    await cleanupWorktreeOnShutdown(3, info, null, (msg) => logs.push(msg));

    const remaining = listWorktreePaths(repo);
    expect(remaining).not.toContain(again);
    expect(logs[0]).toContain("removed");
    expect(logs[0]).toContain("feature/935-dirty-2");
    expect(logs[0]).not.toContain(again);
  });
});
