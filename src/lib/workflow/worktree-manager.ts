/**
 * Worktree Management Module
 *
 * Handles git worktree lifecycle operations for issue isolation:
 * - Creation and reuse of feature worktrees
 * - Staleness detection and refresh
 * - Dependency installation
 *
 * PR-related operations (rebase, PR creation) are in pr-operations.ts
 *
 * @module worktree-manager
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { PM_CONFIG } from "../stacks.js";
import type { CacheMetrics } from "./run-log-schema.js";

// Re-export PR operations for backward compatibility
export {
  type RebaseResult,
  type PRCreationResult,
  createCheckpointCommit,
  reinstallIfLockfileChanged,
  rebaseBeforePR,
  createPR,
} from "./pr-operations.js";

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
