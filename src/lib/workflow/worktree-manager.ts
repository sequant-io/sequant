/**
 * Worktree Management Module
 *
 * Handles git worktree lifecycle operations for issue isolation:
 * - Creation and reuse of feature worktrees
 * - Staleness detection and refresh
 * - Dependency installation
 * - PR creation and rebase operations
 *
 * @module worktree-manager
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { PM_CONFIG } from "../stacks.js";
import type { CacheMetrics } from "./run-log-schema.js";

/**
 * Worktree information for an issue
 */
export interface WorktreeInfo {
  issue: number;
  path: string;
  branch: string;
  existed: boolean;
  /** True if an existing branch was rebased onto the chain base */
  rebased: boolean;
}

/**
 * Result of worktree freshness check
 */
export interface WorktreeFreshnessResult {
  /** True if worktree is stale (significantly behind main) */
  isStale: boolean;
  /** Number of commits behind origin/main */
  commitsBehind: number;
  /** True if worktree has uncommitted changes */
  hasUncommittedChanges: boolean;
  /** True if worktree has unpushed commits */
  hasUnpushedCommits: boolean;
}

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
 * Slugify a title for branch naming
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

/**
 * Get the git repository root directory
 */
export function getGitRoot(): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: "pipe",
  });
  if (result.status === 0) {
    return result.stdout.toString().trim();
  }
  return null;
}

/**
 * Check if a worktree exists for a given branch
 */
export function findExistingWorktree(branch: string): string | null {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });
  if (result.status !== 0) return null;

  const output = result.stdout.toString();
  const lines = output.split("\n");
  let currentPath = "";

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.substring(9);
    } else if (line.startsWith("branch refs/heads/") && line.includes(branch)) {
      return currentPath;
    }
  }
  return null;
}

/**
 * Check if a worktree is stale (behind origin/main) and should be recreated
 *
 * @param worktreePath - Path to the worktree
 * @param verbose - Enable verbose output
 * @returns Freshness check result
 */
export function checkWorktreeFreshness(
  worktreePath: string,
  verbose: boolean,
): WorktreeFreshnessResult {
  const result: WorktreeFreshnessResult = {
    isStale: false,
    commitsBehind: 0,
    hasUncommittedChanges: false,
    hasUnpushedCommits: false,
  };

  // Fetch latest main to ensure accurate comparison
  spawnSync("git", ["-C", worktreePath, "fetch", "origin", "main"], {
    stdio: "pipe",
    timeout: 30000,
  });

  // Check for uncommitted changes
  const statusResult = spawnSync(
    "git",
    ["-C", worktreePath, "status", "--porcelain"],
    { stdio: "pipe" },
  );
  if (statusResult.status === 0) {
    result.hasUncommittedChanges =
      statusResult.stdout.toString().trim().length > 0;
  }

  // Get merge base with origin/main
  const mergeBaseResult = spawnSync(
    "git",
    ["-C", worktreePath, "merge-base", "HEAD", "origin/main"],
    { stdio: "pipe" },
  );
  if (mergeBaseResult.status !== 0) {
    // Can't determine merge base - not stale
    return result;
  }
  const mergeBase = mergeBaseResult.stdout.toString().trim();

  // Get origin/main HEAD
  const mainHeadResult = spawnSync(
    "git",
    ["-C", worktreePath, "rev-parse", "origin/main"],
    { stdio: "pipe" },
  );
  if (mainHeadResult.status !== 0) {
    return result;
  }
  const mainHead = mainHeadResult.stdout.toString().trim();

  // Count commits behind main
  if (mergeBase !== mainHead) {
    const countResult = spawnSync(
      "git",
      ["-C", worktreePath, "rev-list", "--count", `${mergeBase}..${mainHead}`],
      { stdio: "pipe" },
    );
    if (countResult.status === 0) {
      result.commitsBehind = parseInt(countResult.stdout.toString().trim(), 10);
      // Consider stale if more than 5 commits behind (configurable threshold)
      result.isStale = result.commitsBehind > 5;
    }
  }

  // Check for unpushed commits (work in progress)
  const unpushedResult = spawnSync(
    "git",
    ["-C", worktreePath, "log", "--oneline", "@{u}..HEAD"],
    { stdio: "pipe" },
  );
  if (unpushedResult.status === 0) {
    result.hasUnpushedCommits =
      unpushedResult.stdout.toString().trim().length > 0;
  }

  if (verbose && result.isStale) {
    console.log(
      chalk.gray(
        `    📊 Worktree is ${result.commitsBehind} commits behind origin/main`,
      ),
    );
  }

  return result;
}

/**
 * Remove and recreate a stale worktree
 *
 * @param existingPath - Path to existing worktree
 * @param branch - Branch name
 * @param verbose - Enable verbose output
 * @returns true if worktree was removed
 */
export function removeStaleWorktree(
  existingPath: string,
  branch: string,
  verbose: boolean,
): boolean {
  if (verbose) {
    console.log(chalk.gray(`    🗑️  Removing stale worktree...`));
  }

  // Remove the worktree
  const removeResult = spawnSync(
    "git",
    ["worktree", "remove", "--force", existingPath],
    { stdio: "pipe" },
  );

  if (removeResult.status !== 0) {
    const error = removeResult.stderr.toString();
    console.log(chalk.yellow(`    ⚠️  Could not remove worktree: ${error}`));
    return false;
  }

  // Delete the branch so it can be recreated fresh
  const deleteResult = spawnSync("git", ["branch", "-D", branch], {
    stdio: "pipe",
  });

  if (deleteResult.status !== 0 && verbose) {
    console.log(
      chalk.gray(
        `    ℹ️  Branch ${branch} not deleted (may not exist locally)`,
      ),
    );
  }

  return true;
}

/**
 * List all active worktrees with their branches
 */
export function listWorktrees(): Array<{
  path: string;
  branch: string;
  issue: number | null;
}> {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });
  if (result.status !== 0) return [];

  const output = result.stdout.toString();
  const lines = output.split("\n");
  const worktrees: Array<{
    path: string;
    branch: string;
    issue: number | null;
  }> = [];

  let currentPath = "";
  let currentBranch = "";

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      currentPath = line.substring(9);
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.substring(18);
      // Extract issue number from branch name (e.g., feature/123-some-title)
      const issueMatch = currentBranch.match(/feature\/(\d+)-/);
      const issue = issueMatch ? parseInt(issueMatch[1], 10) : null;
      worktrees.push({ path: currentPath, branch: currentBranch, issue });
      currentPath = "";
      currentBranch = "";
    }
  }

  return worktrees;
}

/**
 * Get changed files in a worktree compared to main
 */
export function getWorktreeChangedFiles(worktreePath: string): string[] {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--name-only", "main...HEAD"],
    { stdio: "pipe" },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

/**
 * Get diff stats for a worktree (files changed, lines added)
 * Returns aggregate metrics only - no file paths to preserve privacy
 */
export function getWorktreeDiffStats(worktreePath: string): {
  filesChanged: number;
  linesAdded: number;
} {
  const result = spawnSync(
    "git",
    ["-C", worktreePath, "diff", "--stat", "main...HEAD"],
    { stdio: "pipe" },
  );

  if (result.status !== 0) {
    return { filesChanged: 0, linesAdded: 0 };
  }

  const output = result.stdout.toString();
  const lines = output.trim().split("\n");

  // Summary line is last and looks like: " 5 files changed, 100 insertions(+), 20 deletions(-)"
  const summaryLine = lines[lines.length - 1];
  if (!summaryLine) {
    return { filesChanged: 0, linesAdded: 0 };
  }

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);

  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
  };
}

/**
 * Read cache metrics from QA phase (AC-7)
 *
 * @param worktreePath - Path to the worktree
 * @returns CacheMetrics or undefined if not available
 */
export function readCacheMetrics(
  worktreePath?: string,
): CacheMetrics | undefined {
  const cacheMetricsPath = worktreePath
    ? path.join(worktreePath, ".sequant/.cache/qa/cache-metrics.json")
    : ".sequant/.cache/qa/cache-metrics.json";

  if (!existsSync(cacheMetricsPath)) {
    return undefined;
  }

  try {
    const content = readFileSync(cacheMetricsPath, "utf-8");
    const data = JSON.parse(content);

    if (
      typeof data.hits === "number" &&
      typeof data.misses === "number" &&
      typeof data.skipped === "number"
    ) {
      return {
        hits: data.hits,
        misses: data.misses,
        skipped: data.skipped,
      };
    }
  } catch {
    // Ignore parse errors
  }

  return undefined;
}

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

/**
 * Create or reuse a worktree for an issue
 * @param baseBranch - Optional branch to use as base instead of origin/main (for chain mode)
 * @param chainMode - If true and branch exists, rebase onto baseBranch instead of using as-is
 */
export async function ensureWorktree(
  issueNumber: number,
  title: string,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
  chainMode?: boolean,
): Promise<WorktreeInfo | null> {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.log(chalk.red("    ❌ Not in a git repository"));
    return null;
  }

  const slug = slugify(title);
  const branch = `feature/${issueNumber}-${slug}`;
  const worktreesDir = path.join(path.dirname(gitRoot), "worktrees");
  const worktreePath = path.join(worktreesDir, branch);

  // Check if worktree already exists
  let existingPath = findExistingWorktree(branch);
  if (existingPath) {
    // AC-3: Check if worktree is stale and needs recreation
    const freshness = checkWorktreeFreshness(existingPath, verbose);

    if (freshness.isStale) {
      // AC-3: Handle stale worktrees - check for work in progress
      if (freshness.hasUncommittedChanges) {
        console.log(
          chalk.yellow(
            `    ⚠️  Worktree is ${freshness.commitsBehind} commits behind main but has uncommitted changes`,
          ),
        );
        console.log(
          chalk.yellow(
            `    ℹ️  Keeping existing worktree. Commit or stash changes, then re-run.`,
          ),
        );
        // Continue with existing worktree
      } else if (freshness.hasUnpushedCommits) {
        console.log(
          chalk.yellow(
            `    ⚠️  Worktree is ${freshness.commitsBehind} commits behind main but has unpushed commits`,
          ),
        );
        console.log(
          chalk.yellow(`    ℹ️  Keeping existing worktree with WIP commits.`),
        );
        // Continue with existing worktree
      } else {
        // Safe to recreate - no uncommitted/unpushed work
        console.log(
          chalk.yellow(
            `    ⚠️  Worktree is ${freshness.commitsBehind} commits behind main — recreating fresh`,
          ),
        );

        if (removeStaleWorktree(existingPath, branch, verbose)) {
          existingPath = null; // Will fall through to create new worktree
        }
      }
    }
  }

  if (existingPath) {
    if (verbose) {
      console.log(
        chalk.gray(`    📂 Reusing existing worktree: ${existingPath}`),
      );
    }

    // In chain mode, rebase existing worktree onto previous chain link
    if (chainMode && baseBranch) {
      if (verbose) {
        console.log(
          chalk.gray(
            `    🔄 Rebasing existing worktree onto chain base (${baseBranch})...`,
          ),
        );
      }

      const rebaseResult = spawnSync(
        "git",
        ["-C", existingPath, "rebase", baseBranch],
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
              `    ℹ️  Branch ${branch} is not properly chained. Manual rebase may be required.`,
            ),
          );

          // Abort the rebase to restore branch state
          spawnSync("git", ["-C", existingPath, "rebase", "--abort"], {
            stdio: "pipe",
          });
        } else {
          console.log(
            chalk.yellow(`    ⚠️  Rebase failed: ${rebaseError.trim()}`),
          );
          console.log(
            chalk.yellow(
              `    ℹ️  Continuing with branch in its original state.`,
            ),
          );
        }

        return {
          issue: issueNumber,
          path: existingPath,
          branch,
          existed: true,
          rebased: false,
        };
      }

      if (verbose) {
        console.log(
          chalk.green(`    ✅ Existing worktree rebased onto ${baseBranch}`),
        );
      }

      return {
        issue: issueNumber,
        path: existingPath,
        branch,
        existed: true,
        rebased: true,
      };
    }

    return {
      issue: issueNumber,
      path: existingPath,
      branch,
      existed: true,
      rebased: false,
    };
  }

  // Check if branch exists (but no worktree)
  const branchCheck = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { stdio: "pipe" },
  );
  const branchExists = branchCheck.status === 0;

  if (verbose) {
    console.log(chalk.gray(`    🌿 Creating worktree for #${issueNumber}...`));
  }

  // Determine the base for the new branch
  // For custom base branches, use origin/<branch> if it's a remote-style reference
  // For local branches (chain mode), use as-is
  const isLocalBranch =
    baseBranch && !baseBranch.startsWith("origin/") && baseBranch !== "main";
  const baseRef = baseBranch
    ? isLocalBranch
      ? baseBranch
      : baseBranch.startsWith("origin/")
        ? baseBranch
        : `origin/${baseBranch}`
    : "origin/main";

  // Fetch the base branch to ensure worktree starts from fresh baseline
  const branchToFetch = baseBranch
    ? baseBranch.replace(/^origin\//, "")
    : "main";
  if (!isLocalBranch) {
    if (verbose) {
      console.log(chalk.gray(`    🔄 Fetching latest ${branchToFetch}...`));
    }
    const fetchResult = spawnSync("git", ["fetch", "origin", branchToFetch], {
      stdio: "pipe",
    });
    if (fetchResult.status !== 0 && verbose) {
      console.log(
        chalk.yellow(
          `    ⚠️  Could not fetch origin/${branchToFetch}, using local state`,
        ),
      );
    }
  } else if (verbose) {
    console.log(chalk.gray(`    🔗 Chaining from branch: ${baseBranch}`));
  }

  // Ensure worktrees directory exists
  if (!existsSync(worktreesDir)) {
    spawnSync("mkdir", ["-p", worktreesDir], { stdio: "pipe" });
  }

  // Create the worktree
  let createResult;
  let needsRebase = false;

  if (branchExists) {
    // Use existing branch
    createResult = spawnSync("git", ["worktree", "add", worktreePath, branch], {
      stdio: "pipe",
    });

    // In chain mode with existing branch, mark for rebase onto previous chain link
    if (chainMode && baseBranch) {
      needsRebase = true;
    }
  } else {
    // Create new branch from base reference (origin/main or previous branch in chain)
    createResult = spawnSync(
      "git",
      ["worktree", "add", worktreePath, "-b", branch, baseRef],
      { stdio: "pipe" },
    );
  }

  if (createResult.status !== 0) {
    const error = createResult.stderr.toString();
    console.log(chalk.red(`    ❌ Failed to create worktree: ${error}`));
    return null;
  }

  // Rebase existing branch onto chain base if needed
  let rebased = false;
  if (needsRebase) {
    if (verbose) {
      console.log(
        chalk.gray(
          `    🔄 Rebasing existing branch onto previous chain link (${baseRef})...`,
        ),
      );
    }

    const rebaseResult = spawnSync(
      "git",
      ["-C", worktreePath, "rebase", baseRef],
      {
        stdio: "pipe",
      },
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
            `    ℹ️  Branch ${branch} is not properly chained. Manual rebase may be required.`,
          ),
        );

        // Abort the rebase to restore branch state
        spawnSync("git", ["-C", worktreePath, "rebase", "--abort"], {
          stdio: "pipe",
        });
      } else {
        console.log(
          chalk.yellow(`    ⚠️  Rebase failed: ${rebaseError.trim()}`),
        );
        console.log(
          chalk.yellow(`    ℹ️  Continuing with branch in its original state.`),
        );
      }
    } else {
      rebased = true;
      if (verbose) {
        console.log(chalk.green(`    ✅ Branch rebased onto ${baseRef}`));
      }
    }
  }

  // Copy .env.local if it exists
  const envLocalSrc = path.join(gitRoot, ".env.local");
  const envLocalDst = path.join(worktreePath, ".env.local");
  if (existsSync(envLocalSrc) && !existsSync(envLocalDst)) {
    spawnSync("cp", [envLocalSrc, envLocalDst], { stdio: "pipe" });
  }

  // Copy .claude/settings.local.json if it exists
  const claudeSettingsSrc = path.join(
    gitRoot,
    ".claude",
    "settings.local.json",
  );
  const claudeSettingsDst = path.join(
    worktreePath,
    ".claude",
    "settings.local.json",
  );
  if (existsSync(claudeSettingsSrc) && !existsSync(claudeSettingsDst)) {
    spawnSync("mkdir", ["-p", path.join(worktreePath, ".claude")], {
      stdio: "pipe",
    });
    spawnSync("cp", [claudeSettingsSrc, claudeSettingsDst], { stdio: "pipe" });
  }

  // Install dependencies if needed
  const nodeModulesPath = path.join(worktreePath, "node_modules");
  if (!existsSync(nodeModulesPath)) {
    if (verbose) {
      console.log(chalk.gray(`    📦 Installing dependencies...`));
    }
    // Use detected package manager or default to npm
    const pm = (packageManager as keyof typeof PM_CONFIG) || "npm";
    const pmConfig = PM_CONFIG[pm];
    const [cmd, ...args] = pmConfig.installSilent.split(" ");
    spawnSync(cmd, args, {
      cwd: worktreePath,
      stdio: "pipe",
    });
  }

  if (verbose) {
    console.log(chalk.green(`    ✅ Worktree ready: ${worktreePath}`));
  }

  return {
    issue: issueNumber,
    path: worktreePath,
    branch,
    existed: false,
    rebased,
  };
}

/**
 * Ensure worktrees exist for all issues before execution
 * @param baseBranch - Optional base branch for worktree creation (default: main)
 */
export async function ensureWorktrees(
  issues: Array<{ number: number; title: string }>,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
): Promise<Map<number, WorktreeInfo>> {
  const worktrees = new Map<number, WorktreeInfo>();

  const baseDisplay = baseBranch || "main";
  console.log(chalk.blue(`\n  📂 Preparing worktrees from ${baseDisplay}...`));

  for (const issue of issues) {
    const worktree = await ensureWorktree(
      issue.number,
      issue.title,
      verbose,
      packageManager,
      baseBranch,
      false, // Non-chain mode: don't rebase existing branches
    );
    if (worktree) {
      worktrees.set(issue.number, worktree);
    }
  }

  const created = Array.from(worktrees.values()).filter(
    (w) => !w.existed,
  ).length;
  const reused = Array.from(worktrees.values()).filter((w) => w.existed).length;

  if (created > 0 || reused > 0) {
    console.log(
      chalk.gray(`  Worktrees: ${created} created, ${reused} reused`),
    );
  }

  return worktrees;
}

/**
 * Ensure worktrees exist for all issues in chain mode
 * Each issue branches from the previous issue's branch
 * @param baseBranch - Optional starting base branch for the chain (default: main)
 */
export async function ensureWorktreesChain(
  issues: Array<{ number: number; title: string }>,
  verbose: boolean,
  packageManager?: string,
  baseBranch?: string,
): Promise<Map<number, WorktreeInfo>> {
  const worktrees = new Map<number, WorktreeInfo>();

  const baseDisplay = baseBranch || "main";
  console.log(
    chalk.blue(`\n  🔗 Preparing chained worktrees from ${baseDisplay}...`),
  );

  // First issue starts from the specified base branch (or main)
  let previousBranch: string | undefined = baseBranch;

  for (const issue of issues) {
    const worktree = await ensureWorktree(
      issue.number,
      issue.title,
      verbose,
      packageManager,
      previousBranch, // Chain from previous branch (or base branch for first issue)
      true, // Chain mode: rebase existing branches onto previous chain link
    );
    if (worktree) {
      worktrees.set(issue.number, worktree);
      previousBranch = worktree.branch; // Next issue will branch from this
    } else {
      // If worktree creation fails, stop the chain
      console.log(
        chalk.red(
          `  ❌ Chain broken: could not create worktree for #${issue.number}`,
        ),
      );
      break;
    }
  }

  const created = Array.from(worktrees.values()).filter(
    (w) => !w.existed,
  ).length;
  const reused = Array.from(worktrees.values()).filter((w) => w.existed).length;
  const rebased = Array.from(worktrees.values()).filter(
    (w) => w.rebased,
  ).length;

  if (created > 0 || reused > 0) {
    let msg = `  Chained worktrees: ${created} created, ${reused} reused`;
    if (rebased > 0) {
      msg += `, ${rebased} rebased`;
    }
    console.log(chalk.gray(msg));
  }

  // Show chain structure
  if (worktrees.size > 0) {
    const chainOrder = issues
      .filter((i) => worktrees.has(i.number))
      .map((i) => `#${i.number}`)
      .join(" → ");
    console.log(chalk.gray(`  Chain: ${baseDisplay} → ${chainOrder}`));
  }

  return worktrees;
}
