/**
 * Combined branch testing (AC-1)
 *
 * Creates a temporary branch merging all feature branches from a run batch,
 * runs npm test && npm run build on the combined state, and reports results.
 */

import { spawnSync } from "child_process";
import type {
  BranchInfo,
  CheckResult,
  BranchCheckResult,
  CheckFinding,
} from "./types.js";
import { getBranchRef } from "./types.js";

/**
 * Result from merging a branch into the temp branch
 */
interface MergeAttempt {
  issueNumber: number;
  branch: string;
  success: boolean;
  conflictFiles?: string[];
  error?: string;
}

/**
 * Run a git command and return the result
 */
function git(
  args: string[],
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

/**
 * Run npm command and return result
 */
function npm(
  args: string[],
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("npm", args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 120_000, // 2 min timeout for test/build
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

/**
 * Create temp branch, merge all feature branches, run tests and build.
 *
 * @param branches - Feature branches to merge
 * @param repoRoot - Path to the git repository root
 * @returns CheckResult with combined test findings
 */
export function runCombinedBranchTest(
  branches: BranchInfo[],
  repoRoot: string,
): CheckResult {
  const startTime = Date.now();
  const tempBranch = `merge-check/temp-${Date.now()}`;
  const branchResults: BranchCheckResult[] = [];
  const batchFindings: CheckFinding[] = [];
  const mergeAttempts: MergeAttempt[] = [];

  // Save current branch to restore in finally block
  const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);

  try {
    // Fetch latest from remote
    git(["fetch", "origin"], repoRoot);

    // Create temp branch from main
    const createResult = git(
      ["checkout", "-b", tempBranch, "origin/main"],
      repoRoot,
    );
    if (!createResult.ok) {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "error",
        message: `Failed to create temp branch: ${createResult.stderr}`,
      });
      return buildResult(branchResults, batchFindings, startTime);
    }

    // Merge each feature branch
    for (const branch of branches) {
      const mergeResult = git(
        ["merge", "--no-ff", "--no-edit", getBranchRef(branch)],
        repoRoot,
      );

      if (mergeResult.ok) {
        mergeAttempts.push({
          issueNumber: branch.issueNumber,
          branch: branch.branch,
          success: true,
        });
        branchResults.push({
          issueNumber: branch.issueNumber,
          verdict: "PASS",
          findings: [
            {
              check: "combined-branch-test",
              severity: "info",
              message: `Branch merged cleanly into combined state`,
              issueNumber: branch.issueNumber,
            },
          ],
        });
      } else {
        // Get conflicting files
        const conflictResult = git(
          ["diff", "--name-only", "--diff-filter=U"],
          repoRoot,
        );
        const conflictFiles = conflictResult.stdout
          ? conflictResult.stdout.split("\n")
          : [];

        mergeAttempts.push({
          issueNumber: branch.issueNumber,
          branch: branch.branch,
          success: false,
          conflictFiles,
          error: mergeResult.stderr,
        });

        branchResults.push({
          issueNumber: branch.issueNumber,
          verdict: "FAIL",
          findings: [
            {
              check: "combined-branch-test",
              severity: "error",
              message: `Merge conflict with ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
              issueNumber: branch.issueNumber,
            },
          ],
        });

        // Abort the failed merge and continue
        git(["merge", "--abort"], repoRoot);
      }
    }

    // If any merges failed, skip tests but report what we have
    const failedMerges = mergeAttempts.filter((m) => !m.success);
    if (failedMerges.length > 0) {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "error",
        message: `${failedMerges.length}/${branches.length} branches had merge conflicts — skipping test/build`,
      });
      return buildResult(branchResults, batchFindings, startTime);
    }

    // Run npm test
    const testResult = npm(["test"], repoRoot);
    if (testResult.ok) {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "info",
        message: "npm test passed on combined state",
      });
    } else {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "error",
        message: `npm test failed on combined state: ${testResult.stderr.slice(0, 500)}`,
      });
    }

    // Run npm run build
    const buildResult2 = npm(["run", "build"], repoRoot);
    if (buildResult2.ok) {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "info",
        message: "npm run build passed on combined state",
      });
    } else {
      batchFindings.push({
        check: "combined-branch-test",
        severity: "error",
        message: `npm run build failed on combined state: ${buildResult2.stderr.slice(0, 500)}`,
      });
    }

    return buildResult(branchResults, batchFindings, startTime);
  } finally {
    // Clean up: restore original branch and delete temp branch
    const restoreBranch = originalBranch.ok ? originalBranch.stdout : "main";
    git(["checkout", restoreBranch], repoRoot);
    git(["branch", "-D", tempBranch], repoRoot);
  }
}

export function buildResult(
  branchResults: BranchCheckResult[],
  batchFindings: CheckFinding[],
  startTime: number,
): CheckResult {
  const hasErrors = batchFindings.some((f) => f.severity === "error");
  return {
    name: "combined-branch-test",
    passed: !hasErrors,
    branchResults,
    batchFindings,
    durationMs: Date.now() - startTime,
  };
}
