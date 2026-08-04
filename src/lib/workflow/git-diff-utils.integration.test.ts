/**
 * Real-git regression tests for git-diff-utils (#878).
 *
 * The unit suite (git-diff-utils.test.ts) mocks spawnSync; these tests build
 * actual repositories because the #878 defect only manifests against real
 * ref state: a worktree created from `origin/<base>` while the local
 * `<base>` ref is deliberately behind. A mocked test cannot prove the base
 * resolution picks the right ref.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getGitDiffStats,
  getCommitHash,
  resolveDiffBase,
} from "./git-diff-utils.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

/** Configure identity so commits work under the hermetic git config. */
function initRepo(path: string): void {
  execFileSync("git", ["init", "-b", "main", path], { stdio: "pipe" });
  git(path, "config", "user.name", "test");
  git(path, "config", "user.email", "test@example.com");
}

function commitFile(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-m", `add ${file}`);
  return git(repo, "rev-parse", "HEAD");
}

describe("git-diff-utils integration (#878)", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let local: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-diff-utils-878-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    local = join(root, "local");
    worktree = join(root, "wt");

    // Bare "remote" plus a seed clone that populates it.
    execFileSync("git", ["init", "--bare", "-b", "main", origin], {
      stdio: "pipe",
    });
    initRepo(seed);
    commitFile(seed, "base.txt", "base\n");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-u", "origin", "main");

    // The "project" clone — its local main is about to go stale.
    execFileSync("git", ["clone", origin, local], { stdio: "pipe" });
    git(local, "config", "user.name", "test");
    git(local, "config", "user.email", "test@example.com");

    // Advance origin/main past the local clone's main (simulates #778
    // merging upstream after the contributor's last pull).
    commitFile(seed, "upstream.txt", "merged upstream after last pull\n");
    git(seed, "push", "origin", "main");

    // Worktree creation fetches and branches from origin/<base>, exactly
    // like worktree-manager does. Local main deliberately stays behind.
    git(local, "fetch", "origin");
    git(
      local,
      "worktree",
      "add",
      "-b",
      "feature/878-test",
      worktree,
      "origin/main",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("getGitDiffStats (AC-1, AC-3)", () => {
    it("returns zero files for a fresh worktree when local base is behind", () => {
      // Precondition: the fixture really is in the stale-local-ref state —
      // local main behind origin/main, worktree HEAD at the origin tip.
      const localMain = git(local, "rev-parse", "main");
      const originMain = git(local, "rev-parse", "origin/main");
      expect(localMain).not.toBe(originMain);
      expect(git(worktree, "rev-parse", "HEAD")).toBe(originMain);

      // Pre-#878 behavior: main...HEAD resolved to the stale local main and
      // attributed the upstream commit's files to this (empty) branch.
      const result = getGitDiffStats(worktree, "main");
      expect(result.filesModified).toEqual([]);
      expect(result.fileDiffStats).toEqual([]);
      expect(result.totalAdditions).toBe(0);
      expect(result.totalDeletions).toBe(0);
    });

    it("still reports the branch's own commits", () => {
      commitFile(worktree, "feature.txt", "real work\n");
      const result = getGitDiffStats(worktree, "main");
      expect(result.filesModified).toEqual(["feature.txt"]);
      expect(result.fileDiffStats[0]?.status).toBe("added");
    });
  });

  describe("resolveDiffBase", () => {
    it("prefers origin/<base> when the local ref is stale", () => {
      expect(resolveDiffBase(worktree, "main")).toBe("origin/main");
    });

    it("keeps an already-remote-qualified base as-is", () => {
      expect(resolveDiffBase(worktree, "origin/main")).toBe("origin/main");
    });

    it("prefers the local ref for a chain-mode base that is ahead of its remote", () => {
      // Chain mode branches worktrees from a *local* feature branch that may
      // have unpushed commits. Blindly origin-qualifying would re-create the
      // phantom-diff bug in the opposite direction.
      git(local, "branch", "chain-base", "origin/main");
      git(local, "push", "origin", "chain-base");
      const chainWt = join(root, "chain-wt");
      // Advance local chain-base past its pushed counterpart.
      git(local, "checkout", "chain-base");
      commitFile(local, "unpushed.txt", "local-only chain work\n");
      git(
        local,
        "worktree",
        "add",
        "-b",
        "feature/chain",
        chainWt,
        "chain-base",
      );

      expect(resolveDiffBase(chainWt, "chain-base")).toBe("chain-base");
      expect(getGitDiffStats(chainWt, "chain-base").filesModified).toEqual([]);
    });

    it("falls back to the bare ref when no origin counterpart exists", () => {
      git(local, "branch", "local-only", "origin/main");
      const loWt = join(root, "lo-wt");
      git(local, "worktree", "add", "-b", "feature/lo", loWt, "local-only");
      expect(resolveDiffBase(loWt, "local-only")).toBe("local-only");
    });
  });

  describe("getCommitHash (AC-2)", () => {
    it("returns undefined when the branch never moved off its resolved base", () => {
      const base = resolveDiffBase(worktree, "main");
      expect(getCommitHash(worktree, base)).toBeUndefined();
    });

    it("returns HEAD once the branch has its own commit", () => {
      const sha = commitFile(worktree, "feature.txt", "real work\n");
      const base = resolveDiffBase(worktree, "main");
      expect(getCommitHash(worktree, base)).toBe(sha);
    });

    it("keeps bare behavior when no base ref is given (run-level markers)", () => {
      const head = git(worktree, "rev-parse", "HEAD");
      expect(getCommitHash(worktree)).toBe(head);
    });
  });
});
