/**
 * Throwaway git repo for tests that drive the real `exec` phase (#1232).
 *
 * `executePhase` runs the exec change guard (`classifyExecChanges`) against
 * `worktreePath ?? process.cwd()`. A test that passes no worktree therefore
 * runs the guard against the developer's checkout, and on a dirty tree the
 * #1032 rescue commits their work as a `wip checkpoint`. Pass `repo.path` as
 * the `worktreePath` argument instead.
 *
 * The repo's HEAD is one commit ahead of `refs/remotes/origin/main`, so the
 * guard classifies it as `commits` and the phase maps to success — the same
 * outcome CI saw before this fixture existed (no `origin/main` there, so the
 * guard's `rev-list` failed and it failed open).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecTempRepo {
  path: string;
  cleanup: () => void;
}

export function createExecTempRepo(): ExecTempRepo {
  const path = mkdtempSync(join(tmpdir(), "sequant-exec-repo-"));
  const cleanup = () => rmSync(path, { recursive: true, force: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: path, stdio: "pipe" }).toString().trim();

  try {
    initRepo(path, git);
  } catch (error) {
    // Don't leak the temp dir, and surface git's own error unchanged.
    cleanup();
    throw error;
  }
  return { path, cleanup };
}

function initRepo(path: string, git: (...args: string[]) => string): void {
  git("init", "-q", "-b", "feature/test");
  // Identity before the first commit: CI runners have no global git identity.
  git("config", "user.name", "sequant-test");
  git("config", "user.email", "sequant-test@example.invalid");
  git("config", "commit.gpgsign", "false");

  writeFileSync(join(path, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));

  writeFileSync(join(path, "work.txt"), "work\n");
  git("add", "work.txt");
  git("commit", "-q", "-m", "work");
}
