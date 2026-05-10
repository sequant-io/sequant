/**
 * PR merge detection and branch status utilities
 *
 * @module pr-status
 * @example
 * ```typescript
 * import { checkPRMergeStatus, isBranchMergedIntoMain, isIssueMergedIntoMain } from './pr-status';
 *
 * // Check PR status via GitHub CLI
 * const status = checkPRMergeStatus(123);
 * if (status === 'MERGED') {
 *   console.log('PR is merged');
 * }
 *
 * // Check if branch is merged into main
 * const isMerged = isBranchMergedIntoMain('feature/123-some-feature');
 * ```
 */

import { spawnSync } from "child_process";
import { GitHubProvider } from "./platforms/github.js";
import type { PRMergeStatus } from "./platforms/github.js";

export type { PRMergeStatus };

/**
 * Check the merge status of a PR using the gh CLI
 *
 * @param prNumber - The PR number to check
 * @returns "MERGED" | "CLOSED" | "OPEN" | null (null if PR not found or gh unavailable)
 */
export function checkPRMergeStatus(prNumber: number): PRMergeStatus {
  const github = new GitHubProvider();
  return github.getPRMergeStatusSync(prNumber);
}

/**
 * Check if a branch has been merged into a base branch using git
 *
 * "Merged" here means the branch was the source of an actual merge commit on
 * the base branch — i.e., the branch tip appears as a non-first parent of some
 * merge commit reachable from baseBranch. This deliberately excludes the case
 * where the branch tip is just an ancestor of baseBranch with no commits ever
 * added (e.g., a worktree branch created from main that was abandoned before
 * any commits were made). Those branches are reachable from main but were
 * never merged in any meaningful sense; the older `git branch --merged` check
 * misclassified them as merged and caused subsequent runs to skip the still-
 * open issue.
 *
 * Squash-merged branches do not satisfy this check (their tip is not on main
 * after squash) — callers that need to detect squash merges should rely on
 * commit-message detection (see {@link isIssueMergedIntoMain}'s `--grep` path)
 * or a PR API check.
 *
 * @param branchName - The branch name to check (e.g., "feature/33-some-title")
 * @param baseBranch - The base branch to check against (default: "main")
 * @returns true if a merge commit on baseBranch records branchName's tip as a
 *   non-first parent, false otherwise
 */
export function isBranchMergedIntoMain(
  branchName: string,
  baseBranch: string = "main",
): boolean {
  try {
    // Resolve the branch tip SHA. If the branch can't be resolved (deleted,
    // typo'd, etc.), it can't be "merged" by any definition.
    const tipResult = spawnSync("git", ["rev-parse", branchName], {
      stdio: "pipe",
      timeout: 10000,
    });
    if (tipResult.status !== 0) return false;
    const branchTip = tipResult.stdout.toString().trim();
    if (!branchTip) return false;

    // Walk recent merge commits on baseBranch and check whether any records
    // the branch tip as a non-first parent. The first parent of a merge
    // commit is the prior tip of baseBranch; non-first parents are the
    // sources being merged in.
    const mergesResult = spawnSync(
      "git",
      ["rev-list", "--merges", "--parents", "-200", baseBranch],
      { stdio: "pipe", timeout: 10000 },
    );

    if (mergesResult.status === 0 && mergesResult.stdout) {
      const lines = mergesResult.stdout.toString().trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        const parts = line.split(" ");
        if (parts.length > 2 && parts.slice(2).includes(branchTip)) {
          return true;
        }
      }
    }
  } catch {
    // git command failed - return false
  }

  return false;
}

/**
 * Check if a feature branch for an issue is merged into a base branch
 *
 * Tries multiple detection methods:
 * 1. Find `feature/<N>-*` branches with `git branch -a` and check via {@link isBranchMergedIntoMain}
 * 2. Check for merge commits mentioning the issue
 *
 * @param issueNumber - The issue number to check
 * @param baseBranch - The base branch to check against (default: "main")
 * @returns true if the issue's work is merged into the base branch
 */
export function isIssueMergedIntoMain(
  issueNumber: number,
  baseBranch: string = "main",
): boolean {
  try {
    // Method 1: Check if any feature branch for this issue is merged
    const listResult = spawnSync("git", ["branch", "-a"], {
      stdio: "pipe",
      timeout: 10000,
    });

    if (listResult.status === 0 && listResult.stdout) {
      const branches = listResult.stdout.toString();
      // Find branches matching feature/<issue>-*
      const branchPattern = new RegExp(`feature/${issueNumber}-[^\\s]+`, "g");
      const matchedBranches = branches.match(branchPattern);

      if (matchedBranches) {
        for (const branch of matchedBranches) {
          const cleanBranch = branch.replace(/^\*?\s*/, "").trim();
          if (isBranchMergedIntoMain(cleanBranch, baseBranch)) {
            return true;
          }
        }
      }
    }

    // Method 2: Check for merge commits mentioning the issue
    // Use specific merge patterns to avoid false positives from
    // unrelated commits that merely reference the issue number
    const logResult = spawnSync(
      "git",
      [
        "log",
        baseBranch,
        "--oneline",
        "-20",
        "--grep",
        `Merge #${issueNumber}`,
        "--grep",
        `Merge.*#${issueNumber}`,
        "--grep",
        `(#${issueNumber})`,
      ],
      {
        stdio: "pipe",
        timeout: 10000,
      },
    );

    if (logResult.status === 0 && logResult.stdout) {
      const commits = logResult.stdout.toString().trim();
      if (commits.length > 0) {
        return true;
      }
    }
  } catch {
    // git command failed - return false
  }

  return false;
}
