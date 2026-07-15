/**
 * Integration tests for chain resume (#760).
 *
 * Real git, no mocks of the rebase step. Reuses the #752 pattern
 * (chain-rebase.integration.test.ts): reproduce the worktree shape with real
 * worktrees and exercise the real functions, rather than driving the full
 * `sequant run` (which installs deps and hits GitHub).
 *
 * Scenario (AC-5): a 3-link chain #1 → #2 → #3. Link #1 completes and writes a
 * checkpoint commit; link #2 fails mid-run. On re-run, the resume planner peels
 * #1 as a completed prefix and picks its branch tip as the resume base; the
 * first active link (#2) is rebased onto that tip. We assert #1's checkpoint is
 * an ancestor of #2's HEAD (`merge-base --is-ancestor`, the #752 contract) and
 * that the planner reports #1 skipped with the resume commit (AC-2).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rebaseOntoLocalBranch } from "./worktree-manager.js";
import {
  computeChainResumePlan,
  type CompletedLinkResolver,
} from "./chain-resume.js";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** True iff `ancestor` is an ancestor of `descendant` (the chain contract). */
function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    "git",
    ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant],
    { encoding: "utf-8" },
  );
  return result.status === 0;
}

/** Resolve a branch tip in a given repo (or undefined if it doesn't exist). */
function branchTip(repo: string, ref: string): string | undefined {
  const r = spawnSync(
    "git",
    ["-C", repo, "rev-parse", "--verify", "--quiet", ref],
    {
      encoding: "utf-8",
    },
  );
  return r.status === 0 ? r.stdout.trim() : undefined;
}

describe("chain resume (integration, #760)", () => {
  let root: string;
  let mainRepo: string;
  let link1Worktree: string;
  let link2Worktree: string;
  let link3Worktree: string;
  const link1Branch = "feature/1-alpha";
  const link2Branch = "feature/2-bravo";
  const link3Branch = "feature/3-charlie";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sequant-resume-"));
    mainRepo = join(root, "repo");

    git(root, "init", "--initial-branch=main", "repo");
    git(mainRepo, "config", "user.email", "test@sequant.test");
    git(mainRepo, "config", "user.name", "Test");
    git(mainRepo, "config", "commit.gpgsign", "false");
    writeFileSync(join(mainRepo, "README.md"), "# repo\n");
    git(mainRepo, "add", "README.md");
    git(mainRepo, "commit", "-m", "initial commit");

    // Original run provisions all three links up-front from main (the #748
    // timing shape: successor branches cut while the predecessor still == main).
    link1Worktree = join(root, "worktrees", link1Branch);
    link2Worktree = join(root, "worktrees", link2Branch);
    link3Worktree = join(root, "worktrees", link3Branch);
    git(mainRepo, "worktree", "add", "-b", link1Branch, link1Worktree, "main");
    git(mainRepo, "worktree", "add", "-b", link2Branch, link2Worktree, "main");
    git(mainRepo, "worktree", "add", "-b", link3Branch, link3Worktree, "main");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Resolver backed by the real test repo. */
  function repoResolver(): CompletedLinkResolver {
    return {
      resolveBranchTip: (branch) => branchTip(mainRepo, branch),
      resolveBaseTip: () => branchTip(mainRepo, "main"),
    };
  }

  it("skips the completed prefix and rebases the failed link onto its checkpoint tip (AC-1, AC-2, AC-5)", () => {
    // Link #1 executes, commits its work, and writes a checkpoint (as the
    // sequential loop + createCheckpointCommit would before #2 runs).
    writeFileSync(join(link1Worktree, "feature-1.ts"), "export const a = 1;\n");
    git(link1Worktree, "add", "feature-1.ts");
    git(link1Worktree, "commit", "-m", "feat(#1): exec work");
    git(
      link1Worktree,
      "commit",
      "--allow-empty",
      "-m",
      "checkpoint(#1): QA passed",
    );
    const link1Checkpoint = git(link1Worktree, "rev-parse", "HEAD");

    // Link #2 failed mid-run — its branch is still cut from main (never rebased
    // onto #1), reproducing the wrong-base state a naive resume would leave.
    const link2HeadBefore = git(link2Worktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, link1Checkpoint, link2HeadBefore)).toBe(false);

    // ── Re-run: plan the resume ────────────────────────────────────────
    const plan = computeChainResumePlan(
      [
        { issueNumber: 1, status: "ready_for_merge", branch: link1Branch },
        { issueNumber: 2, status: "in_progress", branch: link2Branch },
        { issueNumber: 3, status: "not_started", branch: link3Branch },
      ],
      "main",
      repoResolver(),
    );

    // AC-2: #1 reported skipped, with the resume commit named.
    expect(plan.skipped).toEqual([
      { issueNumber: 1, status: "ready_for_merge", branch: link1Branch },
    ]);
    expect(plan.resumeIssue).toBe(2);
    expect(plan.resumeBase).toBe(link1Branch);
    expect(plan.resumeBaseCommit).toBe(link1Checkpoint);
    expect(plan.active).toEqual([2, 3]);

    // ── executeSequential's first-active-link rebase onto resumeBase ───
    const rebase = rebaseOntoLocalBranch(
      link2Worktree,
      plan.resumeBase!,
      false,
    );
    expect(rebase.success).toBe(true);
    expect(rebase.conflict).toBe(false);

    // AC-1: #2 now branches from #1's committed checkpoint tip.
    const link2HeadAfter = git(link2Worktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, link1Checkpoint, link2HeadAfter)).toBe(true);
    // #1 was not re-executed — its checkpoint is intact and unchanged.
    expect(git(link1Worktree, "rev-parse", "HEAD")).toBe(link1Checkpoint);
  });

  it("carries the failed link's own partial commits forward on top of the resume base", () => {
    writeFileSync(join(link1Worktree, "feature-1.ts"), "export const a = 1;\n");
    git(link1Worktree, "add", "feature-1.ts");
    git(link1Worktree, "commit", "-m", "feat(#1): exec work");
    const link1Checkpoint = git(link1Worktree, "rev-parse", "HEAD");

    // #2 had committed partial work before it failed.
    writeFileSync(join(link2Worktree, "feature-2.ts"), "export const b = 2;\n");
    git(link2Worktree, "add", "feature-2.ts");
    git(link2Worktree, "commit", "-m", "feat(#2): partial work");

    const plan = computeChainResumePlan(
      [
        { issueNumber: 1, status: "ready_for_merge", branch: link1Branch },
        { issueNumber: 2, status: "in_progress", branch: link2Branch },
      ],
      "main",
      repoResolver(),
    );
    const rebase = rebaseOntoLocalBranch(
      link2Worktree,
      plan.resumeBase!,
      false,
    );
    expect(rebase.success).toBe(true);

    const files = git(link2Worktree, "ls-files");
    expect(files).toContain("feature-1.ts");
    expect(files).toContain("feature-2.ts");
    const link2Head = git(link2Worktree, "rev-parse", "HEAD");
    expect(isAncestor(mainRepo, link1Checkpoint, link2Head)).toBe(true);
  });

  it("fails fast when a ready_for_merge link's branch was destroyed (AC-3)", () => {
    // #1 completed but its branch/worktree were cleaned up mid-way.
    git(mainRepo, "worktree", "remove", "--force", link1Worktree);
    git(mainRepo, "branch", "-D", link1Branch);
    expect(branchTip(mainRepo, link1Branch)).toBeUndefined();

    const plan = computeChainResumePlan(
      [
        { issueNumber: 1, status: "ready_for_merge", branch: link1Branch },
        { issueNumber: 2, status: "in_progress", branch: link2Branch },
      ],
      "main",
      repoResolver(),
    );

    expect(plan.failFast).toBeDefined();
    expect(plan.failFast).toContain(link1Branch);
    expect(plan.resumeBase).toBeUndefined();
  });

  it("resumes from the base branch when the completed prefix was merged (AC-3 merged)", () => {
    // #1's work landed on main (merged); its worktree is gone.
    writeFileSync(join(mainRepo, "feature-1.ts"), "export const a = 1;\n");
    git(mainRepo, "add", "feature-1.ts");
    git(mainRepo, "commit", "-m", "feat(#1): merged to main");
    const mainTip = git(mainRepo, "rev-parse", "HEAD");
    git(mainRepo, "worktree", "remove", "--force", link1Worktree);

    const plan = computeChainResumePlan(
      [
        { issueNumber: 1, status: "merged", branch: link1Branch },
        { issueNumber: 2, status: "in_progress", branch: link2Branch },
      ],
      "main",
      repoResolver(),
    );

    expect(plan.failFast).toBeUndefined();
    expect(plan.resumeBase).toBe("main");
    expect(plan.resumeBaseCommit).toBe(mainTip);
  });
});
