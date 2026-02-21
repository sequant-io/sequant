/**
 * sequant run - Execute workflow for GitHub issues
 *
 * Runs the Sequant workflow (/spec → /exec → /qa) for one or more issues
 * using the Claude Agent SDK for proper skill invocation.
 */

import chalk from "chalk";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getManifest } from "../lib/manifest.js";
import { getSettings } from "../lib/settings.js";
import { PM_CONFIG } from "../lib/stacks.js";
import {
  LogWriter,
  createPhaseLogFromTiming,
} from "../lib/workflow/log-writer.js";
import type { RunConfig } from "../lib/workflow/run-log-schema.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import type { Phase as StatePhase } from "../lib/workflow/state-schema.js";
import {
  Phase,
  DEFAULT_PHASES,
  DEFAULT_CONFIG,
  ExecutionConfig,
  IssueResult,
  PhaseResult,
  QaVerdict,
} from "../lib/workflow/types.js";
import { ShutdownManager } from "../lib/shutdown.js";
import { getMcpServersConfig } from "../lib/system.js";
import { checkVersionCached, getVersionWarning } from "../lib/version-check.js";
import { MetricsWriter } from "../lib/workflow/metrics-writer.js";
import {
  type MetricPhase,
  determineOutcome,
} from "../lib/workflow/metrics-schema.js";
import { getResumablePhasesForIssue } from "../lib/workflow/phase-detection.js";
import { ui, colors } from "../lib/cli-ui.js";
import { PhaseSpinner } from "../lib/phase-spinner.js";
import {
  getGitDiffStats,
  getCommitHash,
} from "../lib/workflow/git-diff-utils.js";
import { getTokenUsageForRun } from "../lib/workflow/token-utils.js";
import type { CacheMetrics } from "../lib/workflow/run-log-schema.js";
import { reconcileStateAtStartup } from "../lib/workflow/state-utils.js";

/**
 * Worktree information for an issue
 */
interface WorktreeInfo {
  issue: number;
  path: string;
  branch: string;
  existed: boolean;
  /** True if an existing branch was rebased onto the chain base */
  rebased: boolean;
}

/**
 * Slugify a title for branch naming
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);
}

/**
 * Parse QA verdict from phase output
 *
 * Looks for verdict patterns in the QA output:
 * - "### Verdict: READY_FOR_MERGE"
 * - "**Verdict:** AC_NOT_MET"
 * - "Verdict: AC_MET_BUT_NOT_A_PLUS"
 *
 * @param output - The captured output from QA phase
 * @returns The parsed verdict or null if not found
 */
export function parseQaVerdict(output: string): QaVerdict | null {
  if (!output) return null;

  // Match various verdict formats:
  // - "### Verdict: X" (markdown header)
  // - "**Verdict:** X" (bold label with colon inside)
  // - "**Verdict:** **X**" (bold label and bold value)
  // - "Verdict: X" (plain)
  // Case insensitive, handles optional markdown formatting
  const verdictMatch = output.match(
    /(?:###?\s*)?(?:\*\*)?Verdict:?\*?\*?\s*\*?\*?\s*(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)\*?\*?/i,
  );

  if (!verdictMatch) return null;

  // Normalize to uppercase with underscores
  const verdict = verdictMatch[1].toUpperCase().replace(/-/g, "_") as QaVerdict;
  return verdict;
}

/**
 * Get the git repository root directory
 */
function getGitRoot(): string | null {
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
function findExistingWorktree(branch: string): string | null {
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
 * Result of worktree freshness check
 */
interface WorktreeFreshnessResult {
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
function readCacheMetrics(worktreePath?: string): CacheMetrics | undefined {
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
 * Filter phases based on resume status.
 *
 * When `resume` is true, calls `getResumablePhasesForIssue` to determine
 * which phases have already completed (via GitHub issue comment markers)
 * and removes them from the execution list.
 *
 * @param issueNumber - GitHub issue number
 * @param phases - The phases to potentially filter
 * @param resume - Whether the --resume flag is set
 * @returns Object with filtered phases and any skipped phases
 */
export function filterResumedPhases(
  issueNumber: number,
  phases: Phase[],
  resume: boolean,
): { phases: Phase[]; skipped: Phase[] } {
  if (!resume) {
    return { phases: [...phases], skipped: [] };
  }

  const resumable = getResumablePhasesForIssue(issueNumber, phases) as Phase[];
  const skipped = phases.filter((p) => !resumable.includes(p));
  return { phases: resumable, skipped };
}

/**
 * Create or reuse a worktree for an issue
 * @param baseBranch - Optional branch to use as base instead of origin/main (for chain mode)
 * @param chainMode - If true and branch exists, rebase onto baseBranch instead of using as-is
 */
async function ensureWorktree(
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
async function ensureWorktrees(
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
async function ensureWorktreesChain(
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
 * Lockfile names for different package managers
 */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lock",
  "yarn.lock",
];

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

  const prTitle = `feat(#${issueNumber}): ${issueTitle}`;
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
 * Natural language prompts for each phase
 * These prompts will invoke the corresponding skills via natural language
 */
const PHASE_PROMPTS: Record<Phase, string> = {
  spec: "Review GitHub issue #{issue} and create an implementation plan with verification criteria. Run the /spec {issue} workflow.",
  "security-review":
    "Perform a deep security analysis for GitHub issue #{issue} focusing on auth, permissions, and sensitive operations. Run the /security-review {issue} workflow.",
  testgen:
    "Generate test stubs for GitHub issue #{issue} based on the specification. Run the /testgen {issue} workflow.",
  exec: "Implement the feature for GitHub issue #{issue} following the spec. Run the /exec {issue} workflow.",
  test: "Execute structured browser-based testing for GitHub issue #{issue}. Run the /test {issue} workflow.",
  qa: "Review the implementation for GitHub issue #{issue} against acceptance criteria. Run the /qa {issue} workflow.",
  loop: "Parse test/QA findings for GitHub issue #{issue} and iterate until quality gates pass. Run the /loop {issue} workflow.",
};

/**
 * UI-related labels that trigger automatic test phase
 */
const UI_LABELS = ["ui", "frontend", "admin", "web", "browser"];

/**
 * Bug-related labels that skip spec phase
 */
const BUG_LABELS = ["bug", "fix", "hotfix", "patch"];

/**
 * Documentation labels that skip spec phase
 */
const DOCS_LABELS = ["docs", "documentation", "readme"];

/**
 * Complex labels that enable quality loop
 */
const COMPLEX_LABELS = ["complex", "refactor", "breaking", "major"];

/**
 * Security-related labels that trigger security-review phase
 */
const SECURITY_LABELS = [
  "security",
  "auth",
  "authentication",
  "permissions",
  "admin",
];

/**
 * Detect phases based on issue labels (like /solve logic)
 */
export function detectPhasesFromLabels(labels: string[]): {
  phases: Phase[];
  qualityLoop: boolean;
} {
  const lowerLabels = labels.map((l) => l.toLowerCase());

  // Check for bug/fix labels → exec → qa (skip spec)
  const isBugFix = lowerLabels.some((label) =>
    BUG_LABELS.some((bugLabel) => label.includes(bugLabel)),
  );

  // Check for docs labels → exec → qa (skip spec)
  const isDocs = lowerLabels.some((label) =>
    DOCS_LABELS.some((docsLabel) => label.includes(docsLabel)),
  );

  // Check for UI labels → add test phase
  const isUI = lowerLabels.some((label) =>
    UI_LABELS.some((uiLabel) => label.includes(uiLabel)),
  );

  // Check for complex labels → enable quality loop
  const isComplex = lowerLabels.some((label) =>
    COMPLEX_LABELS.some((complexLabel) => label.includes(complexLabel)),
  );

  // Check for security labels → add security-review phase
  const isSecurity = lowerLabels.some((label) =>
    SECURITY_LABELS.some((secLabel) => label.includes(secLabel)),
  );

  // Build phase list
  let phases: Phase[];

  if (isBugFix || isDocs) {
    // Simple workflow: exec → qa
    phases = ["exec", "qa"];
  } else if (isUI) {
    // UI workflow: spec → exec → test → qa
    phases = ["spec", "exec", "test", "qa"];
  } else {
    // Standard workflow: spec → exec → qa
    phases = ["spec", "exec", "qa"];
  }

  // Add security-review phase after spec if security labels detected
  if (isSecurity && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    phases.splice(specIndex + 1, 0, "security-review");
  }

  return { phases, qualityLoop: isComplex };
}

/**
 * Parse recommended workflow from /spec output
 *
 * Looks for:
 * ## Recommended Workflow
 * **Phases:** exec → qa
 * **Quality Loop:** enabled|disabled
 */
export function parseRecommendedWorkflow(output: string): {
  phases: Phase[];
  qualityLoop: boolean;
} | null {
  // Find the Recommended Workflow section
  const workflowMatch = output.match(
    /## Recommended Workflow[\s\S]*?\*\*Phases:\*\*\s*([^\n]+)/i,
  );

  if (!workflowMatch) {
    return null;
  }

  // Parse phases from "exec → qa" or "spec → exec → test → qa" format
  const phasesStr = workflowMatch[1].trim();
  const phaseNames = phasesStr
    .split(/\s*→\s*|\s*->\s*|\s*,\s*/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  // Validate and convert to Phase type
  const validPhases: Phase[] = [];
  for (const name of phaseNames) {
    if (
      [
        "spec",
        "security-review",
        "testgen",
        "exec",
        "test",
        "qa",
        "loop",
      ].includes(name)
    ) {
      validPhases.push(name as Phase);
    }
  }

  if (validPhases.length === 0) {
    return null;
  }

  // Parse quality loop setting
  const qualityLoopMatch = output.match(
    /\*\*Quality Loop:\*\*\s*(enabled|disabled|true|false|yes|no)/i,
  );
  const qualityLoop = qualityLoopMatch
    ? ["enabled", "true", "yes"].includes(qualityLoopMatch[1].toLowerCase())
    : false;

  return { phases: validPhases, qualityLoop };
}

interface RunOptions {
  phases?: string;
  sequential?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  timeout?: number;
  logJson?: boolean;
  noLog?: boolean;
  logPath?: string;
  qualityLoop?: boolean;
  maxIterations?: number;
  batch?: string[];
  smartTests?: boolean;
  noSmartTests?: boolean;
  testgen?: boolean;
  autoDetectPhases?: boolean;
  /** Enable automatic worktree creation for issue isolation */
  worktreeIsolation?: boolean;
  /** Reuse existing worktrees instead of creating new ones */
  reuseWorktrees?: boolean;
  /** Suppress version warnings and non-essential output */
  quiet?: boolean;
  /** Chain issues: each branches from previous (requires --sequential) */
  chain?: boolean;
  /**
   * Wait for QA pass before starting next issue in chain mode.
   * When enabled, the chain pauses if QA fails, preventing downstream issues
   * from building on potentially broken code.
   */
  qaGate?: boolean;
  /**
   * Base branch for worktree creation.
   * Resolution priority: this CLI flag → settings.run.defaultBase → 'main'
   */
  base?: string;
  /**
   * Disable MCP servers in headless mode.
   * When true, MCPs are not passed to the SDK (faster/cheaper runs).
   * Resolution priority: this CLI flag → settings.run.mcp → default (true)
   */
  noMcp?: boolean;
  /**
   * Resume from last completed phase.
   * Reads phase markers from GitHub issue comments and skips completed phases.
   */
  resume?: boolean;
  /**
   * Disable automatic retry with MCP fallback.
   * When true, no retry attempts are made on phase failure.
   * Useful for debugging to see the actual failure without retry masking it.
   */
  noRetry?: boolean;
  /**
   * Skip pre-PR rebase onto origin/main.
   * When true, branches are not rebased before creating the PR.
   * Use when you want to preserve branch state or handle rebasing manually.
   */
  noRebase?: boolean;
  /**
   * Skip PR creation after successful QA.
   * When true, branches are pushed but no PR is created.
   * Useful for manual workflows where PRs are created separately.
   */
  noPr?: boolean;
  /**
   * Force re-execution of issues even if they have completed status.
   * Bypasses the pre-flight state guard that skips ready_for_merge/merged issues.
   */
  force?: boolean;
}

/**
 * Format duration in human-readable format
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

/**
 * Get the prompt for a phase with the issue number substituted
 */
function getPhasePrompt(phase: Phase, issueNumber: number): string {
  return PHASE_PROMPTS[phase].replace(/\{issue\}/g, String(issueNumber));
}

/**
 * Phases that require worktree isolation (exec, test, qa)
 * Spec runs in main repo since it's planning-only
 */
const ISOLATED_PHASES: Phase[] = ["exec", "test", "qa"];

/**
 * Execute a single phase for an issue using Claude Agent SDK
 */
async function executePhase(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhaseSpinner,
): Promise<PhaseResult & { sessionId?: string }> {
  const startTime = Date.now();

  if (config.dryRun) {
    // Dry run - just simulate
    if (config.verbose) {
      console.log(chalk.gray(`    Would execute: /${phase} ${issueNumber}`));
    }
    return {
      phase,
      success: true,
      durationSeconds: 0,
    };
  }

  const prompt = getPhasePrompt(phase, issueNumber);

  if (config.verbose) {
    console.log(chalk.gray(`    Prompt: ${prompt}`));
    if (worktreePath && ISOLATED_PHASES.includes(phase)) {
      console.log(chalk.gray(`    Worktree: ${worktreePath}`));
    }
  }

  // Determine working directory and environment
  const shouldUseWorktree = worktreePath && ISOLATED_PHASES.includes(phase);
  const cwd = shouldUseWorktree ? worktreePath : process.cwd();

  // Track stderr for error diagnostics (declared outside try for catch access)
  let capturedStderr = "";

  try {
    // Check if shutdown is in progress
    if (shutdownManager?.shuttingDown) {
      return {
        phase,
        success: false,
        durationSeconds: 0,
        error: "Shutdown in progress",
      };
    }

    // Create abort controller for timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, config.phaseTimeout * 1000);

    // Register abort controller with shutdown manager for graceful shutdown
    if (shutdownManager) {
      shutdownManager.setAbortController(abortController);
    }

    let resultSessionId: string | undefined;
    let resultMessage: SDKResultMessage | undefined;
    let lastError: string | undefined;
    let capturedOutput = "";

    // Build environment with worktree isolation variables
    const env: Record<string, string> = {
      ...process.env,
      CLAUDE_HOOKS_SMART_TESTS: config.noSmartTests ? "false" : "true",
    };

    // Set worktree isolation environment variables
    if (shouldUseWorktree) {
      env.SEQUANT_WORKTREE = worktreePath;
      env.SEQUANT_ISSUE = String(issueNumber);
    }

    // Set orchestration context for skills to detect they're part of a workflow
    // Skills can check these to skip redundant pre-flight checks
    env.SEQUANT_ORCHESTRATOR = "sequant-run";
    env.SEQUANT_PHASE = phase;

    // Execute using Claude Agent SDK
    // Note: Don't resume sessions when switching to worktree (different cwd breaks resume)
    const canResume = sessionId && !shouldUseWorktree;

    // Get MCP servers config if enabled
    // Reads from Claude Desktop config and passes to SDK for headless MCP support
    const mcpServers = config.mcp ? getMcpServersConfig() : undefined;

    // Track whether we're actively streaming verbose output
    // Pausing spinner once per streaming session prevents truncation from rapid pause/resume cycles
    // (Issue #283: ora's stop() clears the current line, which can truncate output when
    // pause/resume is called for every chunk in rapid succession)
    let verboseStreamingActive = false;

    const queryInstance = query({
      prompt,
      options: {
        abortController,
        cwd,
        // Load project settings including skills
        settingSources: ["project"],
        // Use Claude Code's system prompt and tools
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        // Bypass permissions for headless execution
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Resume from previous session if provided (but not when switching directories)
        ...(canResume ? { resume: sessionId } : {}),
        // Configure smart tests and worktree isolation via environment
        env,
        // Pass MCP servers for headless mode (AC-2)
        ...(mcpServers ? { mcpServers } : {}),
        // Capture stderr for debugging (helps diagnose early exit failures)
        stderr: (data: string) => {
          capturedStderr += data;
          // Write stderr in verbose mode
          if (config.verbose) {
            // Pause spinner once to avoid truncation (Issue #283)
            if (!verboseStreamingActive) {
              spinner?.pause();
              verboseStreamingActive = true;
            }
            process.stderr.write(chalk.red(data));
          }
        },
      },
    });

    // Stream and process messages
    for await (const message of queryInstance) {
      // Capture session ID from system init message
      if (message.type === "system" && message.subtype === "init") {
        resultSessionId = message.session_id;
      }

      // Capture output from assistant messages
      if (message.type === "assistant") {
        // Extract text content from the message
        const content = message.message.content as Array<{
          type: string;
          text?: string;
        }>;
        const textContent = content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");
        if (textContent) {
          capturedOutput += textContent;
          // Show streaming output in verbose mode
          if (config.verbose) {
            // Pause spinner once at start of streaming to avoid truncation
            // (Issue #283: repeated pause/resume causes ora to clear lines between chunks)
            if (!verboseStreamingActive) {
              spinner?.pause();
              verboseStreamingActive = true;
            }
            process.stdout.write(chalk.gray(textContent));
          }
        }
      }

      // Capture the final result
      if (message.type === "result") {
        resultMessage = message;
      }
    }

    // Resume spinner after streaming completes (if we paused it)
    if (verboseStreamingActive) {
      spinner?.resume();
      verboseStreamingActive = false;
    }

    clearTimeout(timeoutId);

    // Clear abort controller from shutdown manager
    if (shutdownManager) {
      shutdownManager.clearAbortController();
    }

    const durationSeconds = (Date.now() - startTime) / 1000;

    // Check result status
    if (resultMessage) {
      if (resultMessage.subtype === "success") {
        // For QA phase, check the verdict to determine actual success
        // SDK "success" just means the query completed - we need to parse the verdict
        if (phase === "qa" && capturedOutput) {
          const verdict = parseQaVerdict(capturedOutput);
          // Only READY_FOR_MERGE and NEEDS_VERIFICATION are considered passing
          // NEEDS_VERIFICATION is external verification, not a code quality issue
          if (
            verdict &&
            verdict !== "READY_FOR_MERGE" &&
            verdict !== "NEEDS_VERIFICATION"
          ) {
            return {
              phase,
              success: false,
              durationSeconds,
              error: `QA verdict: ${verdict}`,
              sessionId: resultSessionId,
              output: capturedOutput,
              verdict, // Include parsed verdict
            };
          }
          // Pass case - include verdict for logging
          return {
            phase,
            success: true,
            durationSeconds,
            sessionId: resultSessionId,
            output: capturedOutput,
            verdict: verdict ?? undefined, // Include if found
          };
        }

        return {
          phase,
          success: true,
          durationSeconds,
          sessionId: resultSessionId,
          output: capturedOutput,
        };
      } else {
        // Handle error subtypes
        const errorSubtype = resultMessage.subtype;
        if (errorSubtype === "error_max_turns") {
          lastError = "Max turns reached";
        } else if (errorSubtype === "error_during_execution") {
          lastError =
            resultMessage.errors?.join(", ") || "Error during execution";
        } else if (errorSubtype === "error_max_budget_usd") {
          lastError = "Budget limit exceeded";
        } else {
          lastError = `Error: ${errorSubtype}`;
        }

        return {
          phase,
          success: false,
          durationSeconds,
          error: lastError,
          sessionId: resultSessionId,
        };
      }
    }

    // No result message received
    return {
      phase,
      success: false,
      durationSeconds: (Date.now() - startTime) / 1000,
      error: "No result received from Claude",
      sessionId: resultSessionId,
    };
  } catch (err) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const error = err instanceof Error ? err.message : String(err);

    // Check if it was an abort (timeout)
    if (error.includes("abort") || error.includes("AbortError")) {
      return {
        phase,
        success: false,
        durationSeconds,
        error: `Timeout after ${config.phaseTimeout}s`,
      };
    }

    // Include stderr in error message if available (helps diagnose early exit failures)
    const stderrSuffix = capturedStderr
      ? `\nStderr: ${capturedStderr.slice(0, 500)}`
      : "";

    return {
      phase,
      success: false,
      durationSeconds,
      error: error + stderrSuffix,
    };
  }
}

/**
 * Cold-start retry threshold in seconds.
 * Failures under this duration are likely Claude Code subprocess initialization
 * issues rather than genuine phase failures (based on empirical data: cold-start
 * failures consistently complete in 15-39s vs 150-310s for real work).
 */
const COLD_START_THRESHOLD_SECONDS = 60;
const COLD_START_MAX_RETRIES = 2;

/**
 * Execute a phase with automatic retry for cold-start failures and MCP fallback.
 *
 * Retry strategy:
 * 1. If phase fails within COLD_START_THRESHOLD_SECONDS, retry up to COLD_START_MAX_RETRIES times
 * 2. If still failing and MCP is enabled, retry once with MCP disabled (npx-based MCP servers
 *    can fail on first run due to cold-cache issues)
 *
 * The MCP fallback is safe because MCP servers are optional enhancements, not required
 * for core functionality.
 */
/**
 * @internal Exported for testing only
 */
export async function executePhaseWithRetry(
  issueNumber: number,
  phase: Phase,
  config: ExecutionConfig,
  sessionId?: string,
  worktreePath?: string,
  shutdownManager?: ShutdownManager,
  spinner?: PhaseSpinner,
  /** @internal Injected for testing — defaults to module-level executePhase */
  executePhaseFn: typeof executePhase = executePhase,
): Promise<PhaseResult & { sessionId?: string }> {
  // Skip retry logic if explicitly disabled
  if (config.retry === false) {
    return executePhaseFn(
      issueNumber,
      phase,
      config,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );
  }

  let lastResult: PhaseResult & { sessionId?: string };

  // Phase 1: Cold-start retry attempts (with MCP enabled if configured)
  for (let attempt = 0; attempt <= COLD_START_MAX_RETRIES; attempt++) {
    lastResult = await executePhaseFn(
      issueNumber,
      phase,
      config,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );

    const duration = lastResult.durationSeconds ?? 0;

    // Success or genuine failure (took long enough to be real work)
    if (lastResult.success || duration >= COLD_START_THRESHOLD_SECONDS) {
      return lastResult;
    }

    // Cold-start failure detected — retry
    if (attempt < COLD_START_MAX_RETRIES) {
      if (config.verbose) {
        console.log(
          chalk.yellow(
            `\n    ⟳ Cold-start failure detected (${duration.toFixed(1)}s), retrying... (attempt ${attempt + 2}/${COLD_START_MAX_RETRIES + 1})`,
          ),
        );
      }
    }
  }

  // Capture the original error for better diagnostics
  const originalError = lastResult!.error;

  // Phase 2: MCP fallback - if MCP is enabled and we're still failing, try without MCP
  // This handles npx-based MCP servers that fail on first run due to cold-cache issues
  if (config.mcp && !lastResult!.success) {
    console.log(
      chalk.yellow(
        `\n    ⚠️ Phase failed with MCP enabled, retrying without MCP...`,
      ),
    );

    // Create config copy with MCP disabled
    const configWithoutMcp: ExecutionConfig = {
      ...config,
      mcp: false,
    };

    const retryResult = await executePhaseFn(
      issueNumber,
      phase,
      configWithoutMcp,
      sessionId,
      worktreePath,
      shutdownManager,
      spinner,
    );

    if (retryResult.success) {
      console.log(
        chalk.green(
          `    ✓ Phase succeeded without MCP (MCP cold-start issue detected)`,
        ),
      );
      return retryResult;
    }

    // Both attempts failed - return original error for better diagnostics
    return {
      ...lastResult!,
      error: originalError,
    };
  }

  return lastResult!;
}

/**
 * Fetch issue info from GitHub
 */
async function getIssueInfo(
  issueNumber: number,
): Promise<{ title: string; labels: string[] }> {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "title,labels"],
      { stdio: "pipe" },
    );

    if (result.status === 0) {
      const data = JSON.parse(result.stdout.toString());
      return {
        title: data.title || `Issue #${issueNumber}`,
        labels: Array.isArray(data.labels)
          ? data.labels.map((l: { name: string }) => l.name)
          : [],
      };
    }
  } catch {
    // Ignore errors, use defaults
  }

  return { title: `Issue #${issueNumber}`, labels: [] };
}

/**
 * Parse dependencies from issue body and labels
 * Returns array of issue numbers this issue depends on
 */
function parseDependencies(issueNumber: number): number[] {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "body,labels"],
      { stdio: "pipe" },
    );

    if (result.status !== 0) return [];

    const data = JSON.parse(result.stdout.toString());
    const dependencies: number[] = [];

    // Parse from body: "Depends on: #123" or "**Depends on**: #123"
    if (data.body) {
      const bodyMatch = data.body.match(
        /\*?\*?depends\s+on\*?\*?:?\s*#?(\d+)/gi,
      );
      if (bodyMatch) {
        for (const match of bodyMatch) {
          const numMatch = match.match(/(\d+)/);
          if (numMatch) {
            dependencies.push(parseInt(numMatch[1], 10));
          }
        }
      }
    }

    // Parse from labels: "depends-on/123" or "depends-on-123"
    if (data.labels && Array.isArray(data.labels)) {
      for (const label of data.labels) {
        const labelName = label.name || label;
        const labelMatch = labelName.match(/depends-on[-/](\d+)/i);
        if (labelMatch) {
          dependencies.push(parseInt(labelMatch[1], 10));
        }
      }
    }

    return [...new Set(dependencies)]; // Remove duplicates
  } catch {
    return [];
  }
}

/**
 * Sort issues by dependencies (topological sort)
 * Issues with no dependencies come first, then issues that depend on them
 */
function sortByDependencies(issueNumbers: number[]): number[] {
  // Build dependency graph
  const dependsOn = new Map<number, number[]>();
  for (const issue of issueNumbers) {
    const deps = parseDependencies(issue);
    // Only include dependencies that are in our issue list
    dependsOn.set(
      issue,
      deps.filter((d) => issueNumbers.includes(d)),
    );
  }

  // Topological sort using Kahn's algorithm
  const inDegree = new Map<number, number>();
  for (const issue of issueNumbers) {
    inDegree.set(issue, 0);
  }
  for (const deps of dependsOn.values()) {
    for (const dep of deps) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }

  // Note: inDegree counts how many issues depend on each issue
  // We want to process issues that nothing depends on last
  // So we sort by: issues nothing depends on first, then dependent issues
  const sorted: number[] = [];
  const queue: number[] = [];

  // Start with issues that have no dependencies
  for (const issue of issueNumbers) {
    const deps = dependsOn.get(issue) || [];
    if (deps.length === 0) {
      queue.push(issue);
    }
  }

  const visited = new Set<number>();
  while (queue.length > 0) {
    const issue = queue.shift()!;
    if (visited.has(issue)) continue;
    visited.add(issue);
    sorted.push(issue);

    // Find issues that depend on this one
    for (const [other, deps] of dependsOn.entries()) {
      if (deps.includes(issue) && !visited.has(other)) {
        // Check if all dependencies of 'other' are satisfied
        const allDepsSatisfied = deps.every((d) => visited.has(d));
        if (allDepsSatisfied) {
          queue.push(other);
        }
      }
    }
  }

  // Add any remaining issues (circular dependencies or unvisited)
  for (const issue of issueNumbers) {
    if (!visited.has(issue)) {
      sorted.push(issue);
    }
  }

  return sorted;
}

/**
 * Check if an issue has UI-related labels
 */
function hasUILabels(labels: string[]): boolean {
  return labels.some((label) =>
    UI_LABELS.some((uiLabel) => label.toLowerCase().includes(uiLabel)),
  );
}

/**
 * Determine phases to run based on options and issue labels
 */
function determinePhasesForIssue(
  basePhases: Phase[],
  labels: string[],
  options: RunOptions,
): Phase[] {
  const phases = [...basePhases];

  // Add testgen phase after spec if requested
  if (options.testgen && phases.includes("spec")) {
    const specIndex = phases.indexOf("spec");
    if (!phases.includes("testgen")) {
      phases.splice(specIndex + 1, 0, "testgen");
    }
  }

  // Auto-detect UI issues and add test phase
  if (hasUILabels(labels) && !phases.includes("test")) {
    // Add test phase before qa if present, otherwise at the end
    const qaIndex = phases.indexOf("qa");
    if (qaIndex !== -1) {
      phases.splice(qaIndex, 0, "test");
    } else {
      phases.push("test");
    }
  }

  return phases;
}

/**
 * Parse environment variables for CI configuration
 */
function getEnvConfig(): Partial<RunOptions> {
  const config: Partial<RunOptions> = {};

  if (process.env.SEQUANT_QUALITY_LOOP === "true") {
    config.qualityLoop = true;
  }

  if (process.env.SEQUANT_MAX_ITERATIONS) {
    const maxIter = parseInt(process.env.SEQUANT_MAX_ITERATIONS, 10);
    if (!isNaN(maxIter)) {
      config.maxIterations = maxIter;
    }
  }

  if (process.env.SEQUANT_SMART_TESTS === "false") {
    config.noSmartTests = true;
  }

  if (process.env.SEQUANT_TESTGEN === "true") {
    config.testgen = true;
  }

  return config;
}

/**
 * Parse batch arguments into groups of issues
 */
function parseBatches(batchArgs: string[]): number[][] {
  return batchArgs.map((batch) =>
    batch
      .split(/\s+/)
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n)),
  );
}

/**
 * Main run command
 */
export async function runCommand(
  issues: string[],
  options: RunOptions,
): Promise<void> {
  console.log(ui.headerBox("SEQUANT WORKFLOW"));

  // Version freshness check (cached, non-blocking, respects --quiet)
  if (!options.quiet) {
    try {
      const versionResult = await checkVersionCached();
      if (versionResult.isOutdated && versionResult.latestVersion) {
        console.log(
          chalk.yellow(
            `  ⚠️  ${getVersionWarning(versionResult.currentVersion, versionResult.latestVersion, versionResult.isLocalInstall)}`,
          ),
        );
        console.log("");
      }
    } catch {
      // Silent failure - version check is non-critical
    }
  }

  // Check if initialized
  const manifest = await getManifest();
  if (!manifest) {
    console.log(
      chalk.red("❌ Sequant is not initialized. Run `sequant init` first."),
    );
    return;
  }

  // Load settings and merge with environment config and CLI options
  const settings = await getSettings();
  const envConfig = getEnvConfig();

  // Settings provide defaults, env overrides settings, CLI overrides all
  // Note: phases are auto-detected per-issue unless --phases is explicitly set
  // Commander.js converts --no-X to { X: false }, not { noX: true }.
  // Normalize these so RunOptions fields (noLog, noMcp, etc.) work correctly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cliOpts = options as any;
  const normalizedOptions: RunOptions = {
    ...options,
    ...(cliOpts.log === false && { noLog: true }),
    ...(cliOpts.smartTests === false && { noSmartTests: true }),
    ...(cliOpts.mcp === false && { noMcp: true }),
    ...(cliOpts.retry === false && { noRetry: true }),
    ...(cliOpts.rebase === false && { noRebase: true }),
    ...(cliOpts.pr === false && { noPr: true }),
  };

  const mergedOptions: RunOptions = {
    // Settings defaults (phases removed - now auto-detected)
    sequential: normalizedOptions.sequential ?? settings.run.sequential,
    timeout: normalizedOptions.timeout ?? settings.run.timeout,
    logPath: normalizedOptions.logPath ?? settings.run.logPath,
    qualityLoop: normalizedOptions.qualityLoop ?? settings.run.qualityLoop,
    maxIterations:
      normalizedOptions.maxIterations ?? settings.run.maxIterations,
    noSmartTests: normalizedOptions.noSmartTests ?? !settings.run.smartTests,
    // Env overrides
    ...envConfig,
    // CLI explicit options override all
    ...normalizedOptions,
  };

  // Determine if we should auto-detect phases from labels
  const autoDetectPhases = !options.phases && settings.run.autoDetectPhases;
  mergedOptions.autoDetectPhases = autoDetectPhases;

  // Resolve base branch: CLI flag → settings.run.defaultBase → 'main'
  const resolvedBaseBranch =
    options.base ?? settings.run.defaultBase ?? undefined;

  // Parse issue numbers (or use batch mode)
  let issueNumbers: number[];
  let batches: number[][] | null = null;

  if (mergedOptions.batch && mergedOptions.batch.length > 0) {
    batches = parseBatches(mergedOptions.batch);
    issueNumbers = batches.flat();
    console.log(
      chalk.gray(
        `  Batch mode: ${batches.map((b) => `[${b.join(", ")}]`).join(" → ")}`,
      ),
    );
  } else {
    issueNumbers = issues.map((i) => parseInt(i, 10)).filter((n) => !isNaN(n));
  }

  if (issueNumbers.length === 0) {
    console.log(chalk.red("❌ No valid issue numbers provided."));
    console.log(chalk.gray("\nUsage: npx sequant run <issues...> [options]"));
    console.log(chalk.gray("Example: npx sequant run 1 2 3 --sequential"));
    console.log(
      chalk.gray('Batch example: npx sequant run --batch "1 2" --batch "3"'),
    );
    console.log(
      chalk.gray("Chain example: npx sequant run 1 2 3 --sequential --chain"),
    );
    return;
  }

  // Validate chain mode requirements
  if (mergedOptions.chain) {
    if (!mergedOptions.sequential) {
      console.log(chalk.red("❌ --chain requires --sequential flag"));
      console.log(
        chalk.gray(
          "   Chain mode executes issues sequentially, each branching from the previous.",
        ),
      );
      console.log(
        chalk.gray("   Usage: npx sequant run 1 2 3 --sequential --chain"),
      );
      return;
    }

    if (batches) {
      console.log(chalk.red("❌ --chain cannot be used with --batch"));
      console.log(
        chalk.gray(
          "   Chain mode creates a linear dependency chain between issues.",
        ),
      );
      return;
    }

    // Warn about long chains
    if (issueNumbers.length > 5) {
      console.log(
        chalk.yellow(
          `  ⚠️  Warning: Chain has ${issueNumbers.length} issues (recommended max: 5)`,
        ),
      );
      console.log(
        chalk.yellow(
          "     Long chains increase merge complexity and review difficulty.",
        ),
      );
      console.log(
        chalk.yellow(
          "     Consider breaking into smaller chains or using batch mode.",
        ),
      );
      console.log("");
    }
  }

  // Validate QA gate requirements
  if (mergedOptions.qaGate && !mergedOptions.chain) {
    console.log(chalk.red("❌ --qa-gate requires --chain flag"));
    console.log(
      chalk.gray(
        "   QA gate ensures each issue passes QA before the next issue starts.",
      ),
    );
    console.log(
      chalk.gray(
        "   Usage: npx sequant run 1 2 3 --sequential --chain --qa-gate",
      ),
    );
    return;
  }

  // Sort issues by dependencies (if more than one issue)
  if (issueNumbers.length > 1 && !batches) {
    const originalOrder = [...issueNumbers];
    issueNumbers = sortByDependencies(issueNumbers);
    const orderChanged = !originalOrder.every((n, i) => n === issueNumbers[i]);
    if (orderChanged) {
      console.log(
        chalk.gray(
          `  Dependency order: ${issueNumbers.map((n) => `#${n}`).join(" → ")}`,
        ),
      );
    }
  }

  // Build config
  // Note: config.phases is only used when --phases is explicitly set or autoDetect fails
  const explicitPhases = mergedOptions.phases
    ? (mergedOptions.phases.split(",").map((p) => p.trim()) as Phase[])
    : null;

  // Determine MCP enablement: CLI flag (--no-mcp) → settings.run.mcp → default (true)
  const mcpEnabled = mergedOptions.noMcp
    ? false
    : (settings.run.mcp ?? DEFAULT_CONFIG.mcp);

  // Resolve retry setting: CLI flag → settings.run.retry → default (true)
  const retryEnabled = mergedOptions.noRetry
    ? false
    : (settings.run.retry ?? true);

  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: explicitPhases ?? DEFAULT_PHASES,
    sequential: mergedOptions.sequential ?? false,
    dryRun: mergedOptions.dryRun ?? false,
    verbose: mergedOptions.verbose ?? false,
    phaseTimeout: mergedOptions.timeout ?? DEFAULT_CONFIG.phaseTimeout,
    qualityLoop: mergedOptions.qualityLoop ?? false,
    maxIterations: mergedOptions.maxIterations ?? DEFAULT_CONFIG.maxIterations,
    noSmartTests: mergedOptions.noSmartTests ?? false,
    mcp: mcpEnabled,
    retry: retryEnabled,
  };

  // Propagate verbose mode to UI config so spinners use text-only mode.
  // This prevents animated spinner control characters from colliding with
  // verbose console.log() calls from StateManager/MetricsWriter (#282).
  if (config.verbose) {
    ui.configure({ verbose: true });
  }

  // Initialize log writer if JSON logging enabled
  // Default: enabled via settings (logJson: true), can be disabled with --no-log
  let logWriter: LogWriter | null = null;
  const shouldLog =
    !mergedOptions.noLog &&
    !config.dryRun &&
    (mergedOptions.logJson ?? settings.run.logJson);

  if (shouldLog) {
    const runConfig: RunConfig = {
      phases: config.phases,
      sequential: config.sequential,
      qualityLoop: config.qualityLoop,
      maxIterations: config.maxIterations,
      chain: mergedOptions.chain,
      qaGate: mergedOptions.qaGate,
    };

    try {
      logWriter = new LogWriter({
        logPath: mergedOptions.logPath ?? settings.run.logPath,
        verbose: config.verbose,
        startCommit: getCommitHash(process.cwd()),
      });
      await logWriter.initialize(runConfig);
    } catch (err) {
      // Log initialization failure is non-fatal - warn and continue without logging
      // Common causes: permissions issues, disk full, invalid path
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.log(
        chalk.yellow(
          `  ⚠️ Log initialization failed, continuing without logging: ${errorMessage}`,
        ),
      );
      logWriter = null;
    }
  }

  // Initialize state manager for persistent workflow state tracking
  // State tracking is always enabled (unless dry run)
  let stateManager: StateManager | null = null;
  if (!config.dryRun) {
    stateManager = new StateManager({ verbose: config.verbose });
  }

  // Initialize shutdown manager for graceful interruption handling
  const shutdown = new ShutdownManager();

  // Register log writer finalization as cleanup task
  if (logWriter) {
    const writer = logWriter; // Capture for closure
    shutdown.registerCleanup("Finalize run logs", async () => {
      await writer.finalize();
    });
  }

  // Display configuration
  console.log(chalk.gray(`  Stack: ${manifest.stack}`));
  if (autoDetectPhases) {
    console.log(chalk.gray(`  Phases: auto-detect from labels`));
  } else {
    console.log(chalk.gray(`  Phases: ${config.phases.join(" → ")}`));
  }
  console.log(
    chalk.gray(`  Mode: ${config.sequential ? "sequential" : "parallel"}`),
  );
  if (config.qualityLoop) {
    console.log(
      chalk.gray(
        `  Quality loop: enabled (max ${config.maxIterations} iterations)`,
      ),
    );
  }
  if (mergedOptions.testgen) {
    console.log(chalk.gray(`  Testgen: enabled`));
  }
  if (config.noSmartTests) {
    console.log(chalk.gray(`  Smart tests: disabled`));
  }
  if (config.dryRun) {
    console.log(chalk.yellow(`  ⚠️  DRY RUN - no actual execution`));
  }
  if (logWriter) {
    console.log(
      chalk.gray(
        `  Logging: JSON (run ${logWriter.getRunId()?.slice(0, 8)}...)`,
      ),
    );
  }
  if (stateManager) {
    console.log(chalk.gray(`  State tracking: enabled`));
  }
  if (mergedOptions.force) {
    console.log(chalk.yellow(`  Force mode: enabled (bypass state guard)`));
  }
  console.log(
    chalk.gray(`  Issues: ${issueNumbers.map((n) => `#${n}`).join(", ")}`),
  );

  // ============================================================================
  // Pre-flight State Guard (#305)
  // ============================================================================

  // AC-5: Auto-cleanup at run start - reconcile stale ready_for_merge states
  if (stateManager && !config.dryRun) {
    try {
      const reconcileResult = await reconcileStateAtStartup({
        verbose: config.verbose,
      });

      if (reconcileResult.success && reconcileResult.advanced.length > 0) {
        console.log(
          chalk.gray(
            `  State reconciled: ${reconcileResult.advanced.map((n) => `#${n}`).join(", ")} → merged`,
          ),
        );
      }
    } catch {
      // AC-8: Graceful degradation - don't block execution on reconciliation failure
      if (config.verbose) {
        console.log(
          chalk.yellow(`  ⚠️  State reconciliation failed, continuing...`),
        );
      }
    }
  }

  // AC-1 & AC-2: Pre-flight state guard - skip completed issues unless --force
  if (stateManager && !config.dryRun && !mergedOptions.force) {
    const skippedIssues: number[] = [];
    const activeIssues: number[] = [];

    for (const issueNumber of issueNumbers) {
      try {
        const issueState = await stateManager.getIssueState(issueNumber);
        if (
          issueState &&
          (issueState.status === "ready_for_merge" ||
            issueState.status === "merged")
        ) {
          skippedIssues.push(issueNumber);
          console.log(
            chalk.yellow(
              `  ⚠️  #${issueNumber}: already ${issueState.status} — skipping (use --force to re-run)`,
            ),
          );
        } else {
          activeIssues.push(issueNumber);
        }
      } catch {
        // AC-8: Graceful degradation - if state check fails, include the issue
        activeIssues.push(issueNumber);
      }
    }

    // Update issueNumbers to only include active issues
    if (skippedIssues.length > 0) {
      issueNumbers = activeIssues;

      if (issueNumbers.length === 0) {
        console.log(
          chalk.yellow(
            `\n  All issues already completed. Use --force to re-run.`,
          ),
        );
        return;
      }

      console.log(
        chalk.gray(
          `  Active issues: ${issueNumbers.map((n) => `#${n}`).join(", ")}`,
        ),
      );
    }
  }

  // Worktree isolation is enabled by default for multi-issue runs
  const useWorktreeIsolation =
    mergedOptions.worktreeIsolation !== false && issueNumbers.length > 0;

  if (useWorktreeIsolation) {
    console.log(chalk.gray(`  Worktree isolation: enabled`));
  }
  if (resolvedBaseBranch) {
    console.log(chalk.gray(`  Base branch: ${resolvedBaseBranch}`));
  }
  if (mergedOptions.chain) {
    console.log(
      chalk.gray(`  Chain mode: enabled (each issue branches from previous)`),
    );
  }
  if (mergedOptions.qaGate) {
    console.log(chalk.gray(`  QA gate: enabled (chain waits for QA pass)`));
  }

  // Fetch issue info for all issues first
  const issueInfoMap = new Map<number, { title: string; labels: string[] }>();
  for (const issueNumber of issueNumbers) {
    issueInfoMap.set(issueNumber, await getIssueInfo(issueNumber));
  }

  // Create worktrees for all issues before execution (if isolation enabled)
  let worktreeMap: Map<number, WorktreeInfo> = new Map();
  if (useWorktreeIsolation && !config.dryRun) {
    const issueData = issueNumbers.map((num) => ({
      number: num,
      title: issueInfoMap.get(num)?.title || `Issue #${num}`,
    }));

    // Use chain mode or standard worktree creation
    if (mergedOptions.chain) {
      worktreeMap = await ensureWorktreesChain(
        issueData,
        config.verbose,
        manifest.packageManager,
        resolvedBaseBranch,
      );
    } else {
      worktreeMap = await ensureWorktrees(
        issueData,
        config.verbose,
        manifest.packageManager,
        resolvedBaseBranch,
      );
    }

    // Register cleanup tasks for newly created worktrees (not pre-existing ones)
    for (const [issueNum, worktree] of worktreeMap.entries()) {
      if (!worktree.existed) {
        shutdown.registerCleanup(
          `Cleanup worktree for #${issueNum}`,
          async () => {
            // Remove worktree (leaves branch intact for recovery)
            const result = spawnSync(
              "git",
              ["worktree", "remove", "--force", worktree.path],
              {
                stdio: "pipe",
              },
            );
            if (result.status !== 0 && config.verbose) {
              console.log(
                chalk.yellow(
                  `    Warning: Could not remove worktree ${worktree.path}`,
                ),
              );
            }
          },
        );
      }
    }
  }

  // Execute with graceful shutdown handling
  const results: IssueResult[] = [];
  let exitCode = 0;

  try {
    if (batches) {
      // Batch execution: run batches sequentially, issues within batch based on mode
      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        console.log(
          chalk.blue(
            `\n  Batch ${batchIdx + 1}/${batches.length}: Issues ${batch.map((n) => `#${n}`).join(", ")}`,
          ),
        );

        const batchResults = await executeBatch(
          batch,
          config,
          logWriter,
          stateManager,
          mergedOptions,
          issueInfoMap,
          worktreeMap,
          shutdown,
          manifest.packageManager,
        );
        results.push(...batchResults);

        // Check if batch failed and we should stop
        const batchFailed = batchResults.some((r) => !r.success);
        if (batchFailed && config.sequential) {
          console.log(
            chalk.yellow(
              `\n  ⚠️  Batch ${batchIdx + 1} failed, stopping batch execution`,
            ),
          );
          break;
        }
      }
    } else if (config.sequential) {
      // Sequential execution
      for (let i = 0; i < issueNumbers.length; i++) {
        const issueNumber = issueNumbers[i];
        const issueInfo = issueInfoMap.get(issueNumber) ?? {
          title: `Issue #${issueNumber}`,
          labels: [],
        };
        const worktreeInfo = worktreeMap.get(issueNumber);

        // Start issue logging
        if (logWriter) {
          logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
        }

        const result = await runIssueWithLogging(
          issueNumber,
          config,
          logWriter,
          stateManager,
          issueInfo.title,
          issueInfo.labels,
          mergedOptions,
          worktreeInfo?.path,
          worktreeInfo?.branch,
          shutdown,
          mergedOptions.chain, // Enable checkpoint commits in chain mode
          manifest.packageManager,
          // In chain mode, only the last issue should trigger pre-PR rebase
          mergedOptions.chain ? i === issueNumbers.length - 1 : undefined,
        );
        results.push(result);

        // Record PR info in log before completing issue
        if (logWriter && result.prNumber && result.prUrl) {
          logWriter.setPRInfo(result.prNumber, result.prUrl);
        }

        // Complete issue logging
        if (logWriter) {
          logWriter.completeIssue();
        }

        // Check if shutdown was triggered
        if (shutdown.shuttingDown) {
          break;
        }

        if (!result.success) {
          // Check if QA gate is enabled and QA specifically failed
          if (mergedOptions.qaGate) {
            const qaResult = result.phaseResults.find((p) => p.phase === "qa");
            const qaFailed = qaResult && !qaResult.success;

            if (qaFailed) {
              // QA gate: pause chain with clear messaging
              console.log(chalk.yellow("\n  ⏸️  QA Gate"));
              console.log(
                chalk.yellow(
                  `     Issue #${issueNumber} QA did not pass. Chain paused.`,
                ),
              );
              console.log(
                chalk.gray(
                  "     Fix QA issues and re-run, or run /loop to auto-fix.",
                ),
              );

              // Update state to waiting_for_qa_gate
              if (stateManager) {
                try {
                  await stateManager.updateIssueStatus(
                    issueNumber,
                    "waiting_for_qa_gate",
                  );
                } catch {
                  // State tracking errors shouldn't stop execution
                }
              }
              break;
            }
          }

          const chainInfo = mergedOptions.chain ? " (chain stopped)" : "";
          console.log(
            chalk.yellow(
              `\n  ⚠️  Issue #${issueNumber} failed, stopping sequential execution${chainInfo}`,
            ),
          );
          break;
        }
      }
    } else {
      // Parallel execution (for now, just run sequentially but don't stop on failure)
      // TODO: Add proper parallel execution with listr2
      for (const issueNumber of issueNumbers) {
        // Check if shutdown was triggered
        if (shutdown.shuttingDown) {
          break;
        }

        const issueInfo = issueInfoMap.get(issueNumber) ?? {
          title: `Issue #${issueNumber}`,
          labels: [],
        };
        const worktreeInfo = worktreeMap.get(issueNumber);

        // Start issue logging
        if (logWriter) {
          logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
        }

        const result = await runIssueWithLogging(
          issueNumber,
          config,
          logWriter,
          stateManager,
          issueInfo.title,
          issueInfo.labels,
          mergedOptions,
          worktreeInfo?.path,
          worktreeInfo?.branch,
          shutdown,
          false, // Parallel mode doesn't support chain
          manifest.packageManager,
        );
        results.push(result);

        // Record PR info in log before completing issue
        if (logWriter && result.prNumber && result.prUrl) {
          logWriter.setPRInfo(result.prNumber, result.prUrl);
        }

        // Complete issue logging
        if (logWriter) {
          logWriter.completeIssue();
        }
      }
    }

    // Finalize log
    let logPath: string | null = null;
    if (logWriter) {
      logPath = await logWriter.finalize({
        endCommit: getCommitHash(process.cwd()),
      });
    }

    // Calculate success/failure counts
    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    // Record metrics (local analytics)
    if (!config.dryRun && results.length > 0) {
      try {
        const metricsWriter = new MetricsWriter({ verbose: config.verbose });

        // Calculate total duration
        const totalDuration = results.reduce(
          (sum, r) => sum + (r.durationSeconds ?? 0),
          0,
        );

        // Get unique phases from all results
        const allPhases = new Set<MetricPhase>();
        for (const result of results) {
          for (const phaseResult of result.phaseResults) {
            // Only include phases that are valid MetricPhases
            const phase = phaseResult.phase as MetricPhase;
            if (
              [
                "spec",
                "security-review",
                "testgen",
                "exec",
                "test",
                "qa",
                "loop",
              ].includes(phase)
            ) {
              allPhases.add(phase);
            }
          }
        }

        // Calculate aggregate metrics from worktrees
        let totalFilesChanged = 0;
        let totalLinesAdded = 0;
        let totalQaIterations = 0;

        for (const result of results) {
          const worktreeInfo = worktreeMap.get(result.issueNumber);
          if (worktreeInfo?.path) {
            const stats = getWorktreeDiffStats(worktreeInfo.path);
            totalFilesChanged += stats.filesChanged;
            totalLinesAdded += stats.linesAdded;
          }
          // Count QA iterations (loop phases indicate retries)
          if (result.loopTriggered) {
            totalQaIterations += result.phaseResults.filter(
              (p) => p.phase === "loop",
            ).length;
          }
        }

        // Build CLI flags for metrics
        const cliFlags: string[] = [];
        if (mergedOptions.sequential) cliFlags.push("--sequential");
        if (mergedOptions.chain) cliFlags.push("--chain");
        if (mergedOptions.qaGate) cliFlags.push("--qa-gate");
        if (mergedOptions.qualityLoop) cliFlags.push("--quality-loop");
        if (mergedOptions.testgen) cliFlags.push("--testgen");

        // Read token usage from SessionEnd hook files (AC-5, AC-6)
        const tokenUsage = getTokenUsageForRun(undefined, true); // cleanup after reading

        // Record the run
        await metricsWriter.recordRun({
          issues: issueNumbers,
          phases: Array.from(allPhases),
          outcome: determineOutcome(passed, results.length),
          duration: totalDuration,
          model: process.env.ANTHROPIC_MODEL ?? "opus",
          flags: cliFlags,
          metrics: {
            tokensUsed: tokenUsage.tokensUsed,
            filesChanged: totalFilesChanged,
            linesAdded: totalLinesAdded,
            acceptanceCriteria: 0, // Would need to parse from issue
            qaIterations: totalQaIterations,
            // Token breakdown (AC-6)
            inputTokens: tokenUsage.inputTokens || undefined,
            outputTokens: tokenUsage.outputTokens || undefined,
            cacheTokens: tokenUsage.cacheTokens || undefined,
          },
        });

        if (config.verbose) {
          console.log(
            chalk.gray(`  📊 Metrics recorded to .sequant/metrics.json`),
          );
        }
      } catch (metricsError) {
        // Metrics recording errors shouldn't stop execution
        if (config.verbose) {
          console.log(
            chalk.yellow(`  ⚠️  Metrics recording error: ${metricsError}`),
          );
        }
      }
    }

    // Summary
    console.log("\n" + ui.divider());
    console.log(colors.info("  Summary"));
    console.log(ui.divider());

    console.log(
      colors.muted(
        `\n  Results: ${colors.success(`${passed} passed`)}, ${colors.error(`${failed} failed`)}`,
      ),
    );

    for (const result of results) {
      const status = result.success
        ? ui.statusIcon("success")
        : ui.statusIcon("error");
      const duration = result.durationSeconds
        ? colors.muted(` (${formatDuration(result.durationSeconds)})`)
        : "";
      const phases = result.phaseResults
        .map((p) =>
          p.success ? colors.success(p.phase) : colors.error(p.phase),
        )
        .join(" → ");
      const loopInfo = result.loopTriggered ? colors.warning(" [loop]") : "";
      const prInfo = result.prUrl
        ? colors.muted(` → PR #${result.prNumber}`)
        : "";
      console.log(
        `  ${status} #${result.issueNumber}: ${phases}${loopInfo}${prInfo}${duration}`,
      );
    }

    console.log("");

    if (logPath) {
      console.log(colors.muted(`  📝 Log: ${logPath}`));
      console.log("");
    }

    if (config.dryRun) {
      console.log(
        colors.warning(
          "  ℹ️  This was a dry run. Use without --dry-run to execute.",
        ),
      );
      console.log("");
    }

    // Set exit code if any failed
    if (failed > 0 && !config.dryRun) {
      exitCode = 1;
    }
  } finally {
    // Always dispose shutdown manager to clean up signal handlers
    shutdown.dispose();
  }

  // Exit with error if any failed (outside try/finally so dispose() runs first)
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

/**
 * Execute a batch of issues
 */
async function executeBatch(
  issueNumbers: number[],
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  stateManager: StateManager | null,
  options: RunOptions,
  issueInfoMap: Map<number, { title: string; labels: string[] }>,
  worktreeMap: Map<number, WorktreeInfo>,
  shutdownManager?: ShutdownManager,
  packageManager?: string,
): Promise<IssueResult[]> {
  const results: IssueResult[] = [];

  for (const issueNumber of issueNumbers) {
    // Check if shutdown was triggered
    if (shutdownManager?.shuttingDown) {
      break;
    }

    const issueInfo = issueInfoMap.get(issueNumber) ?? {
      title: `Issue #${issueNumber}`,
      labels: [],
    };
    const worktreeInfo = worktreeMap.get(issueNumber);

    // Start issue logging
    if (logWriter) {
      logWriter.startIssue(issueNumber, issueInfo.title, issueInfo.labels);
    }

    const result = await runIssueWithLogging(
      issueNumber,
      config,
      logWriter,
      stateManager,
      issueInfo.title,
      issueInfo.labels,
      options,
      worktreeInfo?.path,
      worktreeInfo?.branch,
      shutdownManager,
      false, // Batch mode doesn't support chain
      packageManager,
    );
    results.push(result);

    // Record PR info in log before completing issue
    if (logWriter && result.prNumber && result.prUrl) {
      logWriter.setPRInfo(result.prNumber, result.prUrl);
    }

    // Complete issue logging
    if (logWriter) {
      logWriter.completeIssue();
    }
  }

  return results;
}

/**
 * Execute all phases for a single issue with logging and quality loop
 */
async function runIssueWithLogging(
  issueNumber: number,
  config: ExecutionConfig,
  logWriter: LogWriter | null,
  stateManager: StateManager | null,
  issueTitle: string,
  labels: string[],
  options: RunOptions,
  worktreePath?: string,
  branch?: string,
  shutdownManager?: ShutdownManager,
  chainMode?: boolean,
  packageManager?: string,
  isLastInChain?: boolean,
): Promise<IssueResult> {
  const startTime = Date.now();
  const phaseResults: PhaseResult[] = [];
  let loopTriggered = false;
  let sessionId: string | undefined;

  console.log(chalk.blue(`\n  Issue #${issueNumber}`));
  if (worktreePath) {
    console.log(chalk.gray(`    Worktree: ${worktreePath}`));
  }

  // Initialize state tracking for this issue
  if (stateManager) {
    try {
      const existingState = await stateManager.getIssueState(issueNumber);
      if (!existingState) {
        await stateManager.initializeIssue(issueNumber, issueTitle, {
          worktree: worktreePath,
          branch,
          qualityLoop: config.qualityLoop,
          maxIterations: config.maxIterations,
        });
      } else {
        // Update worktree info if it changed
        if (worktreePath && branch) {
          await stateManager.updateWorktreeInfo(
            issueNumber,
            worktreePath,
            branch,
          );
        }
      }
    } catch (error) {
      // State tracking errors shouldn't stop execution
      if (config.verbose) {
        console.log(chalk.yellow(`    ⚠️  State tracking error: ${error}`));
      }
    }
  }

  // Determine phases for this specific issue
  let phases: Phase[];
  let detectedQualityLoop = false;
  let specAlreadyRan = false;

  if (options.autoDetectPhases) {
    // Check if labels indicate a simple bug/fix (skip spec entirely)
    const lowerLabels = labels.map((l) => l.toLowerCase());
    const isSimpleBugFix = lowerLabels.some((label) =>
      BUG_LABELS.some((bugLabel) => label.includes(bugLabel)),
    );

    if (isSimpleBugFix) {
      // Simple bug fix: skip spec, go straight to exec → qa
      phases = ["exec", "qa"];
      console.log(chalk.gray(`    Bug fix detected: ${phases.join(" → ")}`));
    } else {
      // Run spec first to get recommended workflow
      console.log(chalk.gray(`    Running spec to determine workflow...`));

      // Create spinner for spec phase (1 of estimated 3: spec, exec, qa)
      const specSpinner = new PhaseSpinner({
        phase: "spec",
        phaseIndex: 1,
        totalPhases: 3, // Estimate; will be refined after spec
        shutdownManager,
      });
      specSpinner.start();

      // Track spec phase start in state
      if (stateManager) {
        try {
          await stateManager.updatePhaseStatus(
            issueNumber,
            "spec",
            "in_progress",
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      const specStartTime = new Date();
      // Note: spec runs in main repo (not worktree) for planning
      const specResult = await executePhaseWithRetry(
        issueNumber,
        "spec",
        config,
        sessionId,
        worktreePath, // Will be ignored for spec (non-isolated phase)
        shutdownManager,
        specSpinner,
      );
      const specEndTime = new Date();

      if (specResult.sessionId) {
        sessionId = specResult.sessionId;
        // Update session ID in state for resume capability
        if (stateManager) {
          try {
            await stateManager.updateSessionId(
              issueNumber,
              specResult.sessionId,
            );
          } catch {
            // State tracking errors shouldn't stop execution
          }
        }
      }

      phaseResults.push(specResult);
      specAlreadyRan = true;

      // Log spec phase result
      // Note: Spec runs in main repo, not worktree, so no git diff stats
      if (logWriter) {
        const phaseLog = createPhaseLogFromTiming(
          "spec",
          issueNumber,
          specStartTime,
          specEndTime,
          specResult.success
            ? "success"
            : specResult.error?.includes("Timeout")
              ? "timeout"
              : "failure",
          { error: specResult.error },
        );
        logWriter.logPhase(phaseLog);
      }

      // Track spec phase completion in state
      if (stateManager) {
        try {
          const phaseStatus = specResult.success ? "completed" : "failed";
          await stateManager.updatePhaseStatus(
            issueNumber,
            "spec",
            phaseStatus,
            {
              error: specResult.error,
            },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      if (!specResult.success) {
        specSpinner.fail(specResult.error);
        const durationSeconds = (Date.now() - startTime) / 1000;
        return {
          issueNumber,
          success: false,
          phaseResults,
          durationSeconds,
          loopTriggered: false,
        };
      }

      specSpinner.succeed();

      // Parse recommended workflow from spec output
      const parsedWorkflow = specResult.output
        ? parseRecommendedWorkflow(specResult.output)
        : null;

      if (parsedWorkflow) {
        // Remove spec from phases since we already ran it
        phases = parsedWorkflow.phases.filter((p) => p !== "spec");
        detectedQualityLoop = parsedWorkflow.qualityLoop;
        console.log(
          chalk.gray(
            `    Spec recommends: ${phases.join(" → ")}${detectedQualityLoop ? " (quality loop)" : ""}`,
          ),
        );
      } else {
        // Fall back to label-based detection
        console.log(
          chalk.yellow(
            `    Could not parse spec recommendation, using label-based detection`,
          ),
        );
        const detected = detectPhasesFromLabels(labels);
        phases = detected.phases.filter((p) => p !== "spec");
        detectedQualityLoop = detected.qualityLoop;
        console.log(chalk.gray(`    Fallback: ${phases.join(" → ")}`));
      }
    }
  } else {
    // Use explicit phases with adjustments
    phases = determinePhasesForIssue(config.phases, labels, options);
    if (phases.length !== config.phases.length) {
      console.log(chalk.gray(`    Phases adjusted: ${phases.join(" → ")}`));
    }
  }

  // Resume: filter out completed phases if --resume flag is set
  if (options.resume) {
    const resumeResult = filterResumedPhases(issueNumber, phases, true);
    if (resumeResult.skipped.length > 0) {
      console.log(
        chalk.gray(
          `    Resume: skipping completed phases: ${resumeResult.skipped.join(", ")}`,
        ),
      );
      phases = resumeResult.phases;
    }
    // Also skip spec if it was auto-detected as completed
    if (
      specAlreadyRan &&
      resumeResult.skipped.length === 0 &&
      resumeResult.phases.length === 0
    ) {
      console.log(chalk.gray(`    Resume: all phases already completed`));
    }
  }

  // Add testgen phase if requested (and spec was in the phases)
  if (
    options.testgen &&
    (phases.includes("spec") || specAlreadyRan) &&
    !phases.includes("testgen")
  ) {
    // Insert testgen at the beginning if spec already ran, otherwise after spec
    if (specAlreadyRan) {
      phases.unshift("testgen");
    } else {
      const specIndex = phases.indexOf("spec");
      if (specIndex !== -1) {
        phases.splice(specIndex + 1, 0, "testgen");
      }
    }
  }

  let iteration = 0;
  const useQualityLoop = config.qualityLoop || detectedQualityLoop;
  const maxIterations = useQualityLoop ? config.maxIterations : 1;
  let completedSuccessfully = false;

  while (iteration < maxIterations) {
    iteration++;

    if (useQualityLoop && iteration > 1) {
      console.log(
        chalk.yellow(
          `    Quality loop iteration ${iteration}/${maxIterations}`,
        ),
      );
      loopTriggered = true;
    }

    let phasesFailed = false;

    // Calculate total phases for progress indicator
    // If spec already ran in auto-detect mode, it's counted separately
    const totalPhases = specAlreadyRan ? phases.length + 1 : phases.length;
    const phaseIndexOffset = specAlreadyRan ? 1 : 0;

    for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx++) {
      const phase = phases[phaseIdx];
      const phaseNumber = phaseIdx + 1 + phaseIndexOffset;

      // Create spinner for this phase
      const phaseSpinner = new PhaseSpinner({
        phase,
        phaseIndex: phaseNumber,
        totalPhases,
        shutdownManager,
        iteration: useQualityLoop ? iteration : undefined,
      });
      phaseSpinner.start();

      // Track phase start in state
      if (stateManager) {
        try {
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase as StatePhase,
            "in_progress",
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      const phaseStartTime = new Date();
      const result = await executePhaseWithRetry(
        issueNumber,
        phase,
        config,
        sessionId,
        worktreePath,
        shutdownManager,
        phaseSpinner,
      );
      const phaseEndTime = new Date();

      // Capture session ID for subsequent phases
      if (result.sessionId) {
        sessionId = result.sessionId;
        // Update session ID in state for resume capability
        if (stateManager) {
          try {
            await stateManager.updateSessionId(issueNumber, result.sessionId);
          } catch {
            // State tracking errors shouldn't stop execution
          }
        }
      }

      phaseResults.push(result);

      // Log phase result with observability data (AC-1, AC-2, AC-3, AC-7)
      if (logWriter) {
        // Capture git diff stats for worktree phases (AC-1, AC-3)
        const diffStats = worktreePath
          ? getGitDiffStats(worktreePath)
          : undefined;

        // Capture commit hash after phase (AC-2)
        const commitHash = worktreePath
          ? getCommitHash(worktreePath)
          : undefined;

        // Read cache metrics for QA phase (AC-7)
        const cacheMetrics =
          phase === "qa" ? readCacheMetrics(worktreePath) : undefined;

        const phaseLog = createPhaseLogFromTiming(
          phase,
          issueNumber,
          phaseStartTime,
          phaseEndTime,
          result.success
            ? "success"
            : result.error?.includes("Timeout")
              ? "timeout"
              : "failure",
          {
            error: result.error,
            verdict: result.verdict,
            // Observability fields (AC-1, AC-2, AC-3, AC-7)
            filesModified: diffStats?.filesModified,
            fileDiffStats: diffStats?.fileDiffStats,
            commitHash,
            cacheMetrics,
          },
        );
        logWriter.logPhase(phaseLog);
      }

      // Track phase completion in state
      if (stateManager) {
        try {
          const phaseStatus = result.success
            ? "completed"
            : result.error?.includes("Timeout")
              ? "failed"
              : "failed";
          await stateManager.updatePhaseStatus(
            issueNumber,
            phase as StatePhase,
            phaseStatus,
            { error: result.error },
          );
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }

      if (result.success) {
        phaseSpinner.succeed();
      } else {
        phaseSpinner.fail(result.error);
        phasesFailed = true;

        // If quality loop enabled, run loop phase to fix issues
        if (useQualityLoop && iteration < maxIterations) {
          // Create spinner for loop phase
          const loopSpinner = new PhaseSpinner({
            phase: "loop",
            phaseIndex: phaseNumber,
            totalPhases,
            shutdownManager,
            iteration,
          });
          loopSpinner.start();

          const loopResult = await executePhaseWithRetry(
            issueNumber,
            "loop",
            config,
            sessionId,
            worktreePath,
            shutdownManager,
            loopSpinner,
          );
          phaseResults.push(loopResult);

          if (loopResult.sessionId) {
            sessionId = loopResult.sessionId;
          }

          if (loopResult.success) {
            loopSpinner.succeed();
            // Continue to next iteration
            break;
          } else {
            loopSpinner.fail(loopResult.error);
          }
        }

        // Stop on first failure (if not in quality loop or loop failed)
        break;
      }
    }

    // If all phases passed, exit the loop
    if (!phasesFailed) {
      completedSuccessfully = true;
      break;
    }

    // If we're not in quality loop mode, don't retry
    if (!config.qualityLoop) {
      break;
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  // Success is determined by whether all phases completed in any iteration,
  // not whether all accumulated phase results passed (which would fail after loop recovery)
  const success = completedSuccessfully;

  // Update final issue status in state
  if (stateManager) {
    try {
      const finalStatus = success ? "ready_for_merge" : "in_progress";
      await stateManager.updateIssueStatus(issueNumber, finalStatus);
    } catch {
      // State tracking errors shouldn't stop execution
    }
  }

  // Create checkpoint commit in chain mode after QA passes
  if (success && chainMode && worktreePath) {
    createCheckpointCommit(worktreePath, issueNumber, config.verbose);
  }

  // Rebase onto origin/main before PR creation (unless --no-rebase)
  // This ensures the branch is up-to-date and prevents lockfile drift
  // AC-1: Non-chain mode rebases onto origin/main before PR
  // AC-2: Chain mode rebases only the final branch onto origin/main before PR
  //        (intermediate branches must stay based on their predecessor)
  const shouldRebase =
    success &&
    worktreePath &&
    !options.noRebase &&
    (!chainMode || isLastInChain);
  if (shouldRebase) {
    rebaseBeforePR(worktreePath, issueNumber, packageManager, config.verbose);
  }

  // Create PR after successful QA + rebase (unless --no-pr)
  let prNumber: number | undefined;
  let prUrl: string | undefined;
  const shouldCreatePR = success && worktreePath && branch && !options.noPr;
  if (shouldCreatePR) {
    const prResult = createPR(
      worktreePath,
      issueNumber,
      issueTitle,
      branch,
      config.verbose,
    );
    if (prResult.success && prResult.prNumber && prResult.prUrl) {
      prNumber = prResult.prNumber;
      prUrl = prResult.prUrl;

      // Update workflow state with PR info
      if (stateManager) {
        try {
          await stateManager.updatePRInfo(issueNumber, {
            number: prResult.prNumber,
            url: prResult.prUrl,
          });
        } catch {
          // State tracking errors shouldn't stop execution
        }
      }
    }
  }

  return {
    issueNumber,
    success,
    phaseResults,
    durationSeconds,
    loopTriggered,
    prNumber,
    prUrl,
  };
}
