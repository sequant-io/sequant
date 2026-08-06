/**
 * Regression tests for repo-scoped worktree resolution (#899).
 *
 * The defect these lock down: `/exec` located an issue's worktree by globbing
 * `../worktrees/feature/<issue>-*`. That directory is a single flat namespace
 * shared by every repository under the same parent, and issue numbers are
 * per-repo — so the glob could match, and the agent could adopt, a completely
 * different project's worktree.
 *
 * These use real git repositories rather than mocks: the entire claim is about
 * what `git worktree list` reports, so mocking it out would test nothing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  resolveIssueWorktree,
  verifyWorktreePath,
} from "./worktree-resolver.js";

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

describe("worktree-resolver (#899)", () => {
  let sandbox: string;
  /** The repo doing the lookup. */
  let repoA: string;
  /** A sibling repo whose worktree squats on the same issue-number slug. */
  let repoB: string;
  /** Shared `worktrees/` dir, mirroring the real `../worktrees/` layout. */
  let sharedWorktrees: string;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "sequant-899-"));
    repoA = path.join(sandbox, "repo-a");
    repoB = path.join(sandbox, "repo-b");
    sharedWorktrees = path.join(sandbox, "worktrees", "feature");
    mkdirSync(sharedWorktrees, { recursive: true });

    initRepo(repoA);
    initRepo(repoB);

    // repo-A's own worktree for #700.
    git(
      repoA,
      "worktree",
      "add",
      "-b",
      "feature/700-repo-a-work",
      path.join(sharedWorktrees, "700-repo-a-work"),
    );

    // repo-B's worktree for ITS #700 — a different project, same slug shape.
    // This is the directory the old glob would have matched from repo-A.
    git(
      repoB,
      "worktree",
      "add",
      "-b",
      "feature/700-repo-b-work",
      path.join(sharedWorktrees, "700-repo-b-work"),
    );

    // A worktree whose directory slug has drifted from its branch. Both
    // identify #810, but only the branch is truthful.
    git(
      repoA,
      "worktree",
      "add",
      "-b",
      "feature/810-renamed-after-the-fact",
      path.join(sharedWorktrees, "810-original-slug"),
    );

    // A plain directory that merely LOOKS like a worktree for #900.
    mkdirSync(path.join(sharedWorktrees, "900-not-a-worktree"), {
      recursive: true,
    });
  });

  afterAll(() => {
    // NOTE: `sandbox` is assigned exactly once, in beforeAll. Do not mutate it
    // anywhere — a mutation testing pass that reassigns it would make this
    // rmSync delete an unintended directory (#883).
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe("resolveIssueWorktree", () => {
    it("does not select a sibling repository's worktree that matches the issue-number glob", () => {
      const result = resolveIssueWorktree(700, repoA);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The core assertion: repo-B's directory matches
      // `worktrees/feature/700-*` on disk, yet is never returned.
      expect(result.path).not.toContain("700-repo-b-work");
      expect(result.path).toContain("700-repo-a-work");
      expect(result.branch).toBe("feature/700-repo-a-work");
    });

    it("resolves the same issue number to each repo's own worktree", () => {
      const fromA = resolveIssueWorktree(700, repoA);
      const fromB = resolveIssueWorktree(700, repoB);

      expect(fromA.ok && fromB.ok).toBe(true);
      if (!fromA.ok || !fromB.ok) return;
      expect(fromA.path).not.toBe(fromB.path);
      expect(fromB.path).toContain("700-repo-b-work");
    });

    it("selects on the branch, not the directory slug, when the two have diverged", () => {
      // Directory says 810-original-slug; branch says 810-renamed-after-the-fact.
      const result = resolveIssueWorktree(810, repoA);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branch).toBe("feature/810-renamed-after-the-fact");
      expect(path.basename(result.path)).toBe("810-original-slug");
    });

    it("does not select a directory that merely matches the slug but is not a worktree", () => {
      const result = resolveIssueWorktree(900, repoA);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("WORKTREE_NOT_FOUND");
    });

    it("reports WORKTREE_NOT_FOUND for an issue with no worktree", () => {
      const result = resolveIssueWorktree(4242, repoA);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("WORKTREE_NOT_FOUND");
      expect(result.message).toContain("4242");
    });
  });

  describe("verifyWorktreePath", () => {
    it("rejects a path that does not exist (AC-3)", () => {
      const result = verifyWorktreePath(path.join(sandbox, "nope"), {
        cwd: repoA,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("SEQUANT_WORKTREE_NOT_FOUND");
    });

    it("rejects an unexpanded glob rather than treating it as a path (AC-3)", () => {
      const result = verifyWorktreePath("../worktrees/feature/899-*/", {
        cwd: repoA,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("SEQUANT_WORKTREE_NOT_FOUND");
    });

    it("rejects a real directory belonging to another repository (AC-4)", () => {
      const foreign = path.join(sharedWorktrees, "700-repo-b-work");
      const result = verifyWorktreePath(foreign, { cwd: repoA });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("SEQUANT_WORKTREE_FOREIGN");
    });

    it("accepts the same path when checked from its owning repository (AC-4)", () => {
      const owned = path.join(sharedWorktrees, "700-repo-b-work");
      const result = verifyWorktreePath(owned, { cwd: repoB });

      expect(result.ok).toBe(true);
    });

    it("rejects a valid worktree of this repo that belongs to a different issue", () => {
      const other = path.join(sharedWorktrees, "810-original-slug");
      const result = verifyWorktreePath(other, { cwd: repoA, issue: 700 });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("SEQUANT_WORKTREE_ISSUE_MISMATCH");
    });

    it("accepts this repo's worktree for the requested issue", () => {
      const owned = path.join(sharedWorktrees, "700-repo-a-work");
      const result = verifyWorktreePath(owned, { cwd: repoA, issue: 700 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branch).toBe("feature/700-repo-a-work");
    });
  });
});
