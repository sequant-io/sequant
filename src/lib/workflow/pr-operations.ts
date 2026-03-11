/**
 * PR Operations Module
 *
 * Handles pre-PR and PR creation operations:
 * - Checkpoint commits for chain recovery
 * - Lockfile change detection and dependency reinstall
 * - Pre-PR rebase onto origin/main
 * - PR creation with existing-PR detection
 *
 * @module pr-operations
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { PM_CONFIG } from "../stacks.js";

/**
 * Result of a pre-PR rebase operation
 */
export interface RebaseResult {
  /** Whether the rebase was performed */
  performed: boolean;
  /** Whether the rebase succeeded */
  success: boolean;
  /** Whether dependencies were reinstalled */
  reinstalled: boolean;
  /** Error message if rebase failed */
  error?: string;
}

/**
 * Result of PR creation
 */
export interface PRCreationResult {
  /** Whether PR creation was attempted */
  attempted: boolean;
  /** Whether PR was created successfully (or already existed) */
  success: boolean;
  /** PR number */
  prNumber?: number;
  /** PR URL */
  prUrl?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Lockfile names for different package managers
 */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "yarn.lock",
];

/**
 * Create a checkpoint commit in the worktree after QA passes
 * This allows recovery in case later issues in the chain fail
 * @internal Exported for testing
 */
export function createCheckpointCommit(
  worktreePath: string,
  issueNumber: number,
  verbose: boolean,
): boolean {
  // Check if there are uncommitted changes
  const statusResult = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { stdio: "pipe" },
  );

  if (statusResult.status !== 0) {
    if (verbose) {
      console.log(
        chalk.yellow(`    ⚠️  Could not check git status for checkpoint`),
      );
    }
    return false;
  }

  const hasChanges = statusResult.stdout.toString().trim().length > 0;
  if (!hasChanges) {
    if (verbose) {
      console.log(
        chalk.gray(`    📌 No changes to checkpoint (already committed)`),
      );
    }
    return true;
  }

  // Stage all changes
  const addResult = spawnSync("git", ["-C", worktreePath, "add", "-A"], {
    stdio: "pipe",
  });

  if (addResult.status !== 0) {
    if (verbose) {
      console.log(
        chalk.yellow(`    ⚠️  Could not stage changes for checkpoint`),
      );
    }
    return false;
  }

  // Create checkpoint commit
  const commitMessage = `checkpoint(#${issueNumber}): QA passed

This is an automatic checkpoint commit created after issue #${issueNumber}
passed QA in chain mode. It serves as a recovery point if later issues fail.`;

  const commitResult = spawnSync(
    "git",
    ["-C", worktreePath, "commit", "-m", commitMessage],
    { stdio: "pipe" },
  );

  if (commitResult.status !== 0) {
    const error = commitResult.stderr.toString();
    if (verbose) {
      console.log(
        chalk.yellow(`    ⚠️  Could not create checkpoint commit: ${error}`),
      );
    }
    return false;
  }

  console.log(
    chalk.green(`    📌 Checkpoint commit created for #${issueNumber}`),
  );
  return true;
}

/**
 * Check if any lockfile changed during a rebase and re-run install if needed.
 * This prevents dependency drift when the lockfile was updated on main.
 * @param worktreePath Path to the worktree
 * @param packageManager Package manager to use for install
 * @param verbose Whether to show verbose output
 * @param preRebaseRef Git ref pointing to pre-rebase HEAD (defaults to ORIG_HEAD,
 *        which git sets automatically after rebase). Using ORIG_HEAD captures all
 *        lockfile changes across multi-commit rebases, unlike HEAD~1 which only
 *        checks the last commit.
 * @returns true if reinstall was performed, false otherwise
 * @internal Exported for testing
 */
export function reinstallIfLockfileChanged(
  worktreePath: string,
  packageManager: string | undefined,
  verbose: boolean,
  preRebaseRef: string = "ORIG_HEAD",
): boolean {
  // Compare pre-rebase state to current HEAD to detect all lockfile changes
  // introduced by the rebase (including changes from main that were pulled in)
  let lockfileChanged = false;

  for (const lockfile of LOCKFILES) {
    const result = spawnSync(
      "git",
      [
        "-C",
        worktreePath,
        "diff",
        "--name-only",
        `${preRebaseRef}..HEAD`,
        "--",
        lockfile,
      ],
      { stdio: "pipe" },
    );

    if (result.status === 0 && result.stdout.toString().trim().length > 0) {
      lockfileChanged = true;
      if (verbose) {
        console.log(chalk.gray(`    📦 Lockfile changed: ${lockfile}`));
      }
      break;
    }
  }

  if (!lockfileChanged) {
    if (verbose) {
      console.log(chalk.gray(`    📦 No lockfile changes detected`));
    }
    return false;
  }

  // Re-run install to sync node_modules with updated lockfile
  console.log(
    chalk.blue(`    📦 Reinstalling dependencies (lockfile changed)...`),
  );

  const pm = (packageManager as keyof typeof PM_CONFIG) || "npm";
  const pmConfig = PM_CONFIG[pm];
  const [cmd, ...args] = pmConfig.installSilent.split(" ");

  const installResult = spawnSync(cmd, args, {
    cwd: worktreePath,
    stdio: "pipe",
  });

  if (installResult.status !== 0) {
    const error = installResult.stderr.toString();
    console.log(
      chalk.yellow(`    ⚠️  Dependency reinstall failed: ${error.trim()}`),
    );
    return false;
  }

  console.log(chalk.green(`    ✅ Dependencies reinstalled`));
  return true;
}

/**
 * Rebase the worktree branch onto origin/main before PR creation.
 * This ensures the branch is up-to-date and prevents lockfile drift.
 *
 * @param worktreePath Path to the worktree
 * @param issueNumber Issue number (for logging)
 * @param packageManager Package manager to use if reinstall needed
 * @param verbose Whether to show verbose output
 * @returns RebaseResult indicating success/failure and whether reinstall was performed
 * @internal Exported for testing
 */
export function rebaseBeforePR(
  worktreePath: string,
  issueNumber: number,
  packageManager: string | undefined,
  verbose: boolean,
): RebaseResult {
  if (verbose) {
    console.log(
      chalk.gray(
        `    🔄 Rebasing #${issueNumber} onto origin/main before PR...`,
      ),
    );
  }

  // Fetch latest main to ensure we're rebasing onto fresh state
  const fetchResult = spawnSync(
    "git",
    ["-C", worktreePath, "fetch", "origin", "main"],
    {
      stdio: "pipe",
    },
  );

  if (fetchResult.status !== 0) {
    const error = fetchResult.stderr.toString();
    console.log(
      chalk.yellow(`    ⚠️  Could not fetch origin/main: ${error.trim()}`),
    );
    // Continue anyway - might work with local state
  }

  // Perform the rebase
  const rebaseResult = spawnSync(
    "git",
    ["-C", worktreePath, "rebase", "origin/main"],
    { stdio: "pipe" },
  );

  if (rebaseResult.status !== 0) {
    const rebaseError = rebaseResult.stderr.toString();

    // Check if it's a conflict
    if (
      rebaseError.includes("CONFLICT") ||
      rebaseError.includes("could not apply")
    ) {
      console.log(
        chalk.yellow(
          `    ⚠️  Rebase conflict detected. Aborting rebase and keeping original branch state.`,
        ),
      );
      console.log(
        chalk.yellow(
          `    ℹ️  PR will be created without rebase. Manual rebase may be required before merge.`,
        ),
      );

      // Abort the rebase to restore branch state
      spawnSync("git", ["-C", worktreePath, "rebase", "--abort"], {
        stdio: "pipe",
      });

      return {
        performed: true,
        success: false,
        reinstalled: false,
        error: "Rebase conflict - manual resolution required",
      };
    } else {
      console.log(chalk.yellow(`    ⚠️  Rebase failed: ${rebaseError.trim()}`));
      console.log(
        chalk.yellow(`    ℹ️  Continuing with branch in its original state.`),
      );

      return {
        performed: true,
        success: false,
        reinstalled: false,
        error: rebaseError.trim(),
      };
    }
  }

  console.log(chalk.green(`    ✅ Branch rebased onto origin/main`));

  // Check if lockfile changed and reinstall if needed
  const reinstalled = reinstallIfLockfileChanged(
    worktreePath,
    packageManager,
    verbose,
  );

  return {
    performed: true,
    success: true,
    reinstalled,
  };
}

/**
 * Push branch and create a PR after successful QA.
 *
 * Handles both fresh PR creation and detection of existing PRs.
 * Failures are warnings — they don't fail the run.
 *
 * @param worktreePath Path to the worktree
 * @param issueNumber Issue number
 * @param issueTitle Issue title (for PR title)
 * @param branch Branch name
 * @param verbose Whether to show verbose output
 * @returns PRCreationResult with PR info or error
 * @internal Exported for testing
 */
export function createPR(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  branch: string,
  verbose: boolean,
  labels?: string[],
): PRCreationResult {
  // Step 1: Check for existing PR on this branch
  const existingPR = spawnSync(
    "gh",
    ["pr", "view", branch, "--json", "number,url"],
    { stdio: "pipe", cwd: worktreePath, timeout: 15000 },
  );

  if (existingPR.status === 0 && existingPR.stdout) {
    try {
      const prInfo = JSON.parse(existingPR.stdout.toString());
      if (prInfo.number && prInfo.url) {
        if (verbose) {
          console.log(
            chalk.gray(
              `    ℹ️  PR #${prInfo.number} already exists for branch ${branch}`,
            ),
          );
        }
        return {
          attempted: true,
          success: true,
          prNumber: prInfo.number,
          prUrl: prInfo.url,
        };
      }
    } catch {
      // JSON parse failed — no existing PR, continue to create
    }
  }

  // Step 2: Push branch to remote
  if (verbose) {
    console.log(chalk.gray(`    🚀 Pushing branch ${branch} to origin...`));
  }

  const pushResult = spawnSync(
    "git",
    ["-C", worktreePath, "push", "-u", "origin", branch],
    { stdio: "pipe", timeout: 60000 },
  );

  if (pushResult.status !== 0) {
    const pushError = pushResult.stderr?.toString().trim() ?? "Unknown error";
    console.log(chalk.yellow(`    ⚠️  git push failed: ${pushError}`));
    return {
      attempted: true,
      success: false,
      error: `git push failed: ${pushError}`,
    };
  }

  // Step 3: Create PR
  if (verbose) {
    console.log(chalk.gray(`    📝 Creating PR for #${issueNumber}...`));
  }

  const isBug = labels?.some((l) => /^bug/i.test(l));
  const prefix = isBug ? "fix" : "feat";
  const prTitle = `${prefix}(#${issueNumber}): ${issueTitle}`;
  const prBody = [
    `## Summary`,
    ``,
    `Automated PR for issue #${issueNumber}.`,
    ``,
    `Fixes #${issueNumber}`,
    ``,
    `---`,
    `🤖 Generated by \`sequant run\``,
  ].join("\n");

  const prResult = spawnSync(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", prBody, "--head", branch],
    { stdio: "pipe", cwd: worktreePath, timeout: 30000 },
  );

  if (prResult.status !== 0) {
    const prError = prResult.stderr?.toString().trim() ?? "Unknown error";
    // Check if PR already exists (race condition or push-before-PR scenarios)
    if (prError.includes("already exists")) {
      const retryView = spawnSync(
        "gh",
        ["pr", "view", branch, "--json", "number,url"],
        { stdio: "pipe", cwd: worktreePath, timeout: 15000 },
      );
      if (retryView.status === 0 && retryView.stdout) {
        try {
          const prInfo = JSON.parse(retryView.stdout.toString());
          return {
            attempted: true,
            success: true,
            prNumber: prInfo.number,
            prUrl: prInfo.url,
          };
        } catch {
          // Fall through to error
        }
      }
    }
    console.log(chalk.yellow(`    ⚠️  PR creation failed: ${prError}`));
    return {
      attempted: true,
      success: false,
      error: `gh pr create failed: ${prError}`,
    };
  }

  // Step 4: Extract PR URL from output and get PR details
  const prOutput = prResult.stdout?.toString().trim() ?? "";
  const prUrlMatch = prOutput.match(
    /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/,
  );

  if (prUrlMatch) {
    const prNumber = parseInt(prUrlMatch[1], 10);
    const prUrl = prUrlMatch[0];
    console.log(chalk.green(`    ✅ PR #${prNumber} created: ${prUrl}`));
    return {
      attempted: true,
      success: true,
      prNumber,
      prUrl,
    };
  }

  // Fallback: try gh pr view to get details
  const viewResult = spawnSync(
    "gh",
    ["pr", "view", branch, "--json", "number,url"],
    { stdio: "pipe", cwd: worktreePath, timeout: 15000 },
  );

  if (viewResult.status === 0 && viewResult.stdout) {
    try {
      const prInfo = JSON.parse(viewResult.stdout.toString());
      console.log(
        chalk.green(`    ✅ PR #${prInfo.number} created: ${prInfo.url}`),
      );
      return {
        attempted: true,
        success: true,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      };
    } catch {
      // Fall through
    }
  }

  // PR was created but we couldn't parse the URL
  console.log(
    chalk.yellow(
      `    ⚠️  PR created but could not extract URL from output: ${prOutput}`,
    ),
  );
  return {
    attempted: true,
    success: true,
    error: "PR created but URL extraction failed",
  };
}
