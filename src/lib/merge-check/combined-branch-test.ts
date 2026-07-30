/**
 * Combined branch testing (AC-1)
 *
 * Creates a temporary branch merging all feature branches from a run batch,
 * reinstalls dependencies when the merge moved a lockfile, then runs the
 * project's test and build scripts on the combined state and reports results.
 */

import { spawnSync } from "child_process";
import type {
  BranchInfo,
  CheckResult,
  BranchCheckResult,
  CheckFinding,
} from "./types.js";
import { getBranchRef } from "./types.js";
import {
  PM_CONFIG,
  detectPackageManagerSync,
  resolvePackageManagerConfig,
} from "../stacks.js";
import {
  toCommandResult,
  resolveFailureReason,
  type CommandResult,
} from "./command-result.js";

// Re-exported for the existing test suite and any downstream consumer that
// imported these from here before they moved to ./command-result.js.
export { resolveFailureReason, type CommandResult };

/**
 * Lockfile names for the JS package managers we support. Kept in sync with the
 * equivalent list in `workflow/worktree-manager.ts`.
 */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "yarn.lock",
];

/**
 * Per-step command timeouts. A dependency install and a full test suite are
 * both slower than the previous flat 2-minute budget allowed. An expired
 * timeout kills the process with `status: null` and no captured output, which
 * showed up as a BLOCKED verdict with no stated reason (#803).
 */
const INSTALL_TIMEOUT_MS = 300_000; // 5 min
const TEST_BUILD_TIMEOUT_MS = 600_000; // 10 min

/** Ref the combined state is built on top of, and compared against. */
const BASE_REF = "origin/main";

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
 * Run a package-manager command line (e.g. "npm ci", "pnpm run build").
 *
 * @param command Full command line, as stored in PM_CONFIG
 * @param cwd Working directory
 * @param timeoutMs Kill the command after this long
 * @internal Exported for testing
 */
export function runPackageManagerCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): CommandResult {
  const [bin, ...args] = command.split(" ");
  const result = spawnSync(bin, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf-8",
    timeout: timeoutMs,
    // On Windows the package managers are `.cmd` shims, which CreateProcess
    // will not resolve from a bare "npm"/"pnpm". `command` is always a constant
    // from PM_CONFIG — never user input — so there is nothing to inject here.
    shell: process.platform === "win32",
  });
  return toCommandResult(result);
}

/**
 * Whether any lockfile differs between `baseRef` and the current HEAD.
 *
 * @internal Exported for testing
 */
export function lockfileChanged(repoRoot: string, baseRef: string): boolean {
  const result = git(
    ["diff", "--name-only", baseRef, "HEAD", "--", ...LOCKFILES],
    repoRoot,
  );
  return result.ok && result.stdout.length > 0;
}

/**
 * Create temp branch, merge all feature branches, reinstall dependencies if the
 * lockfile moved, then run tests and build.
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

  const pm = detectPackageManagerSync(repoRoot);
  // Resolved against the repo rather than read straight off PM_CONFIG: yarn's
  // frozen install differs between classic and berry, and `pm` is "yarn" for
  // both. Resolving once here fixes every `pmConfig.ciInstall` read downstream
  // — three install commands and two user-facing messages (#871).
  const pmConfig = resolvePackageManagerConfig(pm, repoRoot);

  // Flipped the moment we start installing against the combined lockfile, so
  // the caller's node_modules can be put back afterwards. A mutable holder
  // rather than a return value: if runChecks throws, a return value never
  // arrives and the restore would be skipped precisely when the tree is most
  // likely to be inconsistent.
  const installState: InstallState = { installedCombinedDeps: false };

  // Save current branch to restore in the cleanup step
  const originalBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);

  try {
    runChecks(
      branches,
      repoRoot,
      tempBranch,
      pmConfig,
      branchResults,
      batchFindings,
      installState,
    );
  } finally {
    // Restore original branch and delete temp branch
    const restoreBranch = originalBranch.ok ? originalBranch.stdout : "main";
    git(["checkout", restoreBranch], repoRoot);
    git(["branch", "-D", tempBranch], repoRoot);

    // We installed the combined state's dependency tree into the caller's
    // node_modules; put it back so the restored branch is not left running
    // against another branch's dependencies.
    //
    // Frozen again, for the same reason as the forward install: a plain
    // `npm install` normalizes and rewrites the lockfile, which would leave
    // the user's restored branch with a dirty working tree that this check
    // never asked them for.
    if (installState.installedCombinedDeps) {
      const restoreInstall = runPackageManagerCommand(
        pmConfig.ciInstall,
        repoRoot,
        INSTALL_TIMEOUT_MS,
      );
      if (!restoreInstall.ok) {
        batchFindings.push({
          check: "combined-branch-test",
          severity: "warning",
          message: `Dependencies were reinstalled for the combined state but could not be restored for \`${restoreBranch}\`. Run \`${pmConfig.ciInstall}\` to resync node_modules: ${resolveFailureReason(restoreInstall)}`,
        });
      }
    }
  }

  // Built after cleanup so findings pushed during cleanup are reflected in the
  // verdict rather than silently arriving too late to affect `passed`.
  return buildResult(branchResults, batchFindings, startTime);
}

/** Tracks whether the combined state's dependencies were installed. */
interface InstallState {
  installedCombinedDeps: boolean;
}

/**
 * Assemble the combined state and run install/test/build against it.
 *
 * Mutates `branchResults`, `batchFindings`, and `installState` — the last so
 * the caller's cleanup can restore node_modules even if this function throws.
 */
function runChecks(
  branches: BranchInfo[],
  repoRoot: string,
  tempBranch: string,
  pmConfig: (typeof PM_CONFIG)[keyof typeof PM_CONFIG],
  branchResults: BranchCheckResult[],
  batchFindings: CheckFinding[],
  installState: InstallState,
): void {
  const mergeAttempts: MergeAttempt[] = [];

  // Fetch latest from remote
  git(["fetch", "origin"], repoRoot);

  // Create temp branch from main
  const createResult = git(["checkout", "-b", tempBranch, BASE_REF], repoRoot);
  if (!createResult.ok) {
    batchFindings.push({
      check: "combined-branch-test",
      severity: "error",
      message: `Failed to create temp branch: ${createResult.stderr}`,
    });
    return;
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
    return;
  }

  // Reinstall dependencies when the merged branches moved the lockfile (#803).
  // Without this, test/build run against the node_modules of whatever branch
  // the user happened to be on, so a batch that merely added a dependency fails
  // with module-not-found errors — a false BLOCKED on a healthy stack.
  //
  // A frozen install is used rather than a plain one: it mirrors what CI does,
  // it will not rewrite the lockfile (which would dirty the temp branch and
  // break the checkout during cleanup), and it fails loudly on a lockfile that
  // is inconsistent with package.json.
  if (lockfileChanged(repoRoot, BASE_REF)) {
    // Marked before the install runs, not after: a frozen install deletes
    // node_modules up front, so even a failed or interrupted one leaves the
    // caller's tree needing a restore.
    installState.installedCombinedDeps = true;

    const installResult = runPackageManagerCommand(
      pmConfig.ciInstall,
      repoRoot,
      INSTALL_TIMEOUT_MS,
    );

    if (!installResult.ok) {
      // Surface install failures on their own terms rather than letting them
      // resurface downstream as an unexplained test failure.
      batchFindings.push({
        check: "combined-branch-test",
        severity: "error",
        message: `Dependency install failed on combined state (\`${pmConfig.ciInstall}\`) — skipping test/build. The merged lockfile may be inconsistent with package.json: ${resolveFailureReason(installResult)}`,
      });
      return;
    }

    batchFindings.push({
      check: "combined-branch-test",
      severity: "info",
      message: `Lockfile changed in the combined state — reinstalled dependencies with \`${pmConfig.ciInstall}\``,
    });
  }

  // Run the test suite
  const testCommand = `${pmConfig.run} test`;
  const testResult = runPackageManagerCommand(
    testCommand,
    repoRoot,
    TEST_BUILD_TIMEOUT_MS,
  );
  batchFindings.push(
    testResult.ok
      ? {
          check: "combined-branch-test",
          severity: "info",
          message: `\`${testCommand}\` passed on combined state`,
        }
      : {
          check: "combined-branch-test",
          severity: "error",
          message: `\`${testCommand}\` failed on combined state: ${resolveFailureReason(testResult)}`,
        },
  );

  // Run the build
  const buildCommand = `${pmConfig.run} build`;
  const buildOutcome = runPackageManagerCommand(
    buildCommand,
    repoRoot,
    TEST_BUILD_TIMEOUT_MS,
  );
  batchFindings.push(
    buildOutcome.ok
      ? {
          check: "combined-branch-test",
          severity: "info",
          message: `\`${buildCommand}\` passed on combined state`,
        }
      : {
          check: "combined-branch-test",
          severity: "error",
          message: `\`${buildCommand}\` failed on combined state: ${resolveFailureReason(buildOutcome)}`,
        },
  );
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
