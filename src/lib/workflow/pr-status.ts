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

/**
 * PR merge status from GitHub
 */
export type PRMergeStatus = "MERGED" | "CLOSED" | "OPEN" | null;

/**
 * Check the merge status of a PR using the gh CLI
 *
 * @param prNumber - The PR number to check
 * @returns "MERGED" | "CLOSED" | "OPEN" | null (null if PR not found or gh unavailable)
 */
export function checkPRMergeStatus(prNumber: number): PRMergeStatus {
  try {
    const result = spawnSync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "state", "-q", ".state"],
      { stdio: "pipe", timeout: 10000 },
    );

    if (result.status === 0 && result.stdout) {
      const state = result.stdout.toString().trim().toUpperCase();
      if (state === "MERGED") return "MERGED";
      if (state === "CLOSED") return "CLOSED";
      if (state === "OPEN") return "OPEN";
    }
  } catch {
    // gh not available or error - return null
  }

  return null;
}

/**
 * Check if a branch has been merged into main using git
 *
 * @param branchName - The branch name to check (e.g., "feature/33-some-title")
 * @returns true if the branch is merged into main, false otherwise
 */
export function isBranchMergedIntoMain(branchName: string): boolean {
  try {
    // Get branches merged into main
    const result = spawnSync("git", ["branch", "--merged", "main"], {
      stdio: "pipe",
      timeout: 10000,
    });

    if (result.status === 0 && result.stdout) {
      const mergedBranches = result.stdout.toString();
      // Check if our branch is in the list (handle both local and remote refs)
      return (
        mergedBranches.includes(branchName) ||
        mergedBranches.includes(`remotes/origin/${branchName}`)
      );
    }
  } catch {
    // git command failed - return false
  }

  return false;
}

/**
 * Check if a feature branch for an issue is merged into main
 *
 * Tries multiple detection methods:
 * 1. Check if branch exists and is merged via `git branch --merged main`
 * 2. Check for merge commits mentioning the issue
 *
 * @param issueNumber - The issue number to check
 * @returns true if the issue's work is merged into main
 */
export function isIssueMergedIntoMain(issueNumber: number): boolean {
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
          if (isBranchMergedIntoMain(cleanBranch)) {
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
        "main",
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
