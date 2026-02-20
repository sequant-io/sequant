/**
 * State utilities for rebuilding and cleaning up workflow state
 *
 * @example
 * ```typescript
 * import { rebuildStateFromLogs, cleanupStaleEntries } from './state-utils';
 *
 * // Rebuild state from run logs
 * await rebuildStateFromLogs();
 *
 * // Clean up orphaned entries
 * const result = await cleanupStaleEntries({ dryRun: true });
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { StateManager } from "./state-manager.js";
import {
  type IssueState,
  type Phase,
  createEmptyState,
  createIssueState,
  createPhaseState,
} from "./state-schema.js";
import { RunLogSchema, LOG_PATHS } from "./run-log-schema.js";

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

export interface RebuildOptions {
  /** Log directory path (default: .sequant/logs) */
  logPath?: string;
  /** State file path (default: .sequant/state.json) */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface RebuildResult {
  /** Whether rebuild was successful */
  success: boolean;
  /** Number of log files processed */
  logsProcessed: number;
  /** Number of issues found */
  issuesFound: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Rebuild workflow state from run logs
 *
 * Scans all run logs in .sequant/logs/ and reconstructs state
 * based on the most recent activity for each issue.
 */
export async function rebuildStateFromLogs(
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const logPath = options.logPath ?? LOG_PATHS.project;

  if (!fs.existsSync(logPath)) {
    return {
      success: false,
      logsProcessed: 0,
      issuesFound: 0,
      error: `Log directory not found: ${logPath}`,
    };
  }

  try {
    // Find all log files
    const files = fs.readdirSync(logPath).filter((f) => f.endsWith(".json"));

    if (files.length === 0) {
      return {
        success: true,
        logsProcessed: 0,
        issuesFound: 0,
      };
    }

    // Sort by timestamp (newest first)
    files.sort().reverse();

    // Build state from logs
    const state = createEmptyState();
    const issueMap = new Map<number, IssueState>();

    for (const file of files) {
      const filePath = path.join(logPath, file);

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const logData = JSON.parse(content);
        const log = RunLogSchema.safeParse(logData);

        if (!log.success) {
          if (options.verbose) {
            console.log(`⚠️  Invalid log format: ${file}`);
          }
          continue;
        }

        const runLog = log.data;

        // Process each issue in the log
        for (const issueLog of runLog.issues) {
          // Skip if we already have newer data for this issue
          if (issueMap.has(issueLog.issueNumber)) {
            continue;
          }

          // Create issue state from log
          const issueState = createIssueState(
            issueLog.issueNumber,
            issueLog.title,
          );

          // Determine status from log
          if (issueLog.status === "success") {
            issueState.status = "ready_for_merge";
          } else if (issueLog.status === "failure") {
            issueState.status = "in_progress";
          } else {
            issueState.status = "in_progress";
          }

          // Add phase states from log
          for (const phaseLog of issueLog.phases) {
            const phaseState = createPhaseState(
              phaseLog.status === "success"
                ? "completed"
                : phaseLog.status === "failure"
                  ? "failed"
                  : phaseLog.status === "skipped"
                    ? "skipped"
                    : "completed",
            );

            phaseState.startedAt = phaseLog.startTime;
            phaseState.completedAt = phaseLog.endTime;

            if (phaseLog.error) {
              phaseState.error = phaseLog.error;
            }

            issueState.phases[phaseLog.phase] = phaseState;

            // Update current phase to last executed
            issueState.currentPhase = phaseLog.phase as Phase;
          }

          // Set last activity from most recent phase
          const lastPhase = issueLog.phases[issueLog.phases.length - 1];
          if (lastPhase) {
            issueState.lastActivity = lastPhase.endTime;
          }

          issueMap.set(issueLog.issueNumber, issueState);
        }

        if (options.verbose) {
          console.log(`✓ Processed: ${file}`);
        }
      } catch (err) {
        if (options.verbose) {
          console.log(`⚠️  Error reading ${file}: ${err}`);
        }
      }
    }

    // Copy issues to state
    for (const [num, issueState] of issueMap) {
      state.issues[String(num)] = issueState;
    }

    // Save rebuilt state
    const manager = new StateManager({
      statePath: options.statePath,
      verbose: options.verbose,
    });
    await manager.saveState(state);

    return {
      success: true,
      logsProcessed: files.length,
      issuesFound: issueMap.size,
    };
  } catch (error) {
    return {
      success: false,
      logsProcessed: 0,
      issuesFound: 0,
      error: String(error),
    };
  }
}

export interface CleanupOptions {
  /** State file path (default: .sequant/state.json) */
  statePath?: string;
  /** Only report what would be cleaned (don't modify) */
  dryRun?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Remove issues older than this many days */
  maxAgeDays?: number;
  /** Remove all orphaned entries (both merged and abandoned) in one step */
  removeAll?: boolean;
}

export interface CleanupResult {
  /** Whether cleanup was successful */
  success: boolean;
  /** Issues that were removed or would be removed */
  removed: number[];
  /** Issues that were marked as orphaned (abandoned) */
  orphaned: number[];
  /** Issues detected as merged PRs */
  merged: number[];
  /** Error message if failed */
  error?: string;
}

/**
 * Clean up stale and orphaned entries from workflow state
 *
 * - Checks GitHub to detect if associated PR was merged
 * - Orphaned entries with merged PRs get status "merged" and are removed automatically
 * - Orphaned entries without merged PRs get status "abandoned" (kept for review)
 * - Use removeAll to remove both merged and abandoned orphaned entries in one step
 * - Use maxAgeDays to remove old merged/abandoned issues
 */
export async function cleanupStaleEntries(
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const manager = new StateManager({
    statePath: options.statePath,
    verbose: options.verbose,
  });

  if (!manager.stateExists()) {
    return {
      success: true,
      removed: [],
      orphaned: [],
      merged: [],
    };
  }

  try {
    const state = await manager.getState();
    const removed: number[] = [];
    const orphaned: number[] = [];
    const merged: number[] = [];

    // Get list of active worktrees
    const activeWorktrees = getActiveWorktrees();

    for (const [issueNumStr, issueState] of Object.entries(state.issues)) {
      const issueNum = parseInt(issueNumStr, 10);

      // Check if worktree exists (if issue has one)
      if (
        issueState.worktree &&
        !activeWorktrees.includes(issueState.worktree)
      ) {
        if (options.verbose) {
          console.log(
            `🔍 Orphaned: #${issueNum} (worktree not found: ${issueState.worktree})`,
          );
        }

        // Check if this issue has a PR and if it's merged
        let prMerged = false;
        if (issueState.pr?.number) {
          if (options.verbose) {
            console.log(`   Checking PR #${issueState.pr.number} status...`);
          }
          const prStatus = checkPRMergeStatus(issueState.pr.number);
          prMerged = prStatus === "MERGED";
          if (options.verbose) {
            console.log(`   PR status: ${prStatus ?? "unknown"}`);
          }
        }

        if (!options.dryRun) {
          if (prMerged || issueState.status === "merged") {
            // Merged PRs are auto-removed
            merged.push(issueNum);
            removed.push(issueNum);
            if (options.verbose) {
              console.log(`   ✓ Merged PR detected, removing entry`);
            }
            delete state.issues[issueNumStr];
          } else if (issueState.status === "abandoned" || options.removeAll) {
            // Already abandoned or removeAll flag - remove it
            orphaned.push(issueNum);
            removed.push(issueNum);
            if (options.verbose) {
              console.log(`   ✓ Removing abandoned entry`);
            }
            delete state.issues[issueNumStr];
          } else {
            // Mark as abandoned (kept for review)
            orphaned.push(issueNum);
            issueState.status = "abandoned";
            if (options.verbose) {
              console.log(`   → Marked as abandoned (kept for review)`);
            }
          }
        } else {
          // Dry run - report what would happen
          if (prMerged || issueState.status === "merged") {
            merged.push(issueNum);
            removed.push(issueNum);
          } else if (issueState.status === "abandoned" || options.removeAll) {
            orphaned.push(issueNum);
            removed.push(issueNum);
          } else {
            orphaned.push(issueNum);
          }
        }
        continue;
      }

      // Check age for merged/abandoned issues
      if (
        options.maxAgeDays &&
        (issueState.status === "merged" || issueState.status === "abandoned")
      ) {
        const lastActivity = new Date(issueState.lastActivity);
        const ageDays =
          (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);

        if (ageDays > options.maxAgeDays) {
          removed.push(issueNum);

          if (options.verbose) {
            console.log(
              `🗑️  Stale: #${issueNum} (${Math.floor(ageDays)} days old)`,
            );
          }

          if (!options.dryRun) {
            delete state.issues[issueNumStr];
          }
        }
      }
    }

    // Save updated state
    if (!options.dryRun && (removed.length > 0 || orphaned.length > 0)) {
      await manager.saveState(state);
    }

    return {
      success: true,
      removed,
      orphaned,
      merged,
    };
  } catch (error) {
    return {
      success: false,
      removed: [],
      orphaned: [],
      merged: [],
      error: String(error),
    };
  }
}

/**
 * Get list of active worktree paths
 */
function getActiveWorktrees(): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });

  if (result.status !== 0) {
    return [];
  }

  const output = result.stdout.toString();
  const paths: string[] = [];

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.push(line.substring(9));
    }
  }

  return paths;
}

// ============================================================================
// Worktree Discovery for State Bootstrapping
// ============================================================================

export interface DiscoverOptions {
  /** State file path (default: .sequant/state.json) */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface DiscoveredWorktree {
  /** Issue number extracted from branch name */
  issueNumber: number;
  /** Issue title (fetched from GitHub or placeholder) */
  title: string;
  /** Full path to the worktree */
  worktreePath: string;
  /** Branch name */
  branch: string;
  /** Inferred current phase from logs (if available) */
  inferredPhase?: Phase;
}

export interface SkippedWorktree {
  /** Path to the worktree */
  path: string;
  /** Reason it was skipped */
  reason: string;
}

export interface DiscoverResult {
  /** Whether discovery was successful */
  success: boolean;
  /** Number of worktrees scanned */
  worktreesScanned: number;
  /** Number of worktrees already tracked */
  alreadyTracked: number;
  /** Discovered worktrees not yet in state */
  discovered: DiscoveredWorktree[];
  /** Worktrees that were skipped (not matching pattern, etc.) */
  skipped: SkippedWorktree[];
  /** Error message if failed */
  error?: string;
}

/**
 * Parse issue number from a branch name
 *
 * Supports patterns:
 * - feature/<number>-<slug>
 * - issue-<number>
 * - <number>-<slug>
 */
function parseIssueNumberFromBranch(branch: string): number | null {
  // Pattern: feature/123-description or feature/123
  const featureMatch = branch.match(/^feature\/(\d+)(?:-|$)/);
  if (featureMatch) {
    return parseInt(featureMatch[1], 10);
  }

  // Pattern: issue-123
  const issueMatch = branch.match(/^issue-(\d+)$/);
  if (issueMatch) {
    return parseInt(issueMatch[1], 10);
  }

  // Pattern: 123-description (bare number prefix)
  const bareMatch = branch.match(/^(\d+)-/);
  if (bareMatch) {
    return parseInt(bareMatch[1], 10);
  }

  return null;
}

/**
 * Fetch issue title from GitHub using gh CLI
 *
 * Returns placeholder if gh is not available or fetch fails.
 */
function fetchIssueTitle(issueNumber: number): string {
  try {
    const result = spawnSync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "title", "-q", ".title"],
      { stdio: "pipe", timeout: 10000 },
    );

    if (result.status === 0 && result.stdout) {
      const title = result.stdout.toString().trim();
      if (title) {
        return title;
      }
    }
  } catch {
    // gh not available or error - use placeholder
  }

  return `(title unavailable for #${issueNumber})`;
}

/**
 * Get detailed worktree information including branch names
 */
interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

function getWorktreeDetails(): WorktreeInfo[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    stdio: "pipe",
  });

  if (result.status !== 0) {
    return [];
  }

  const output = result.stdout.toString();
  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      // Start of new worktree entry
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.substring(5);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.substring(18);
    } else if (line === "" && current.path) {
      // End of entry
      worktrees.push(current as WorktreeInfo);
      current = {};
    }
  }

  // Don't forget the last entry
  if (current.path && current.branch) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
}

/**
 * Infer the current phase for an issue by checking logs
 */
function inferPhaseFromLogs(issueNumber: number): Phase | undefined {
  const logPath = LOG_PATHS.project;

  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  try {
    const files = fs.readdirSync(logPath).filter((f) => f.endsWith(".json"));

    // Sort by timestamp (newest first)
    files.sort().reverse();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(logPath, file), "utf-8");
        const logData = JSON.parse(content);
        const log = RunLogSchema.safeParse(logData);

        if (!log.success) continue;

        // Find this issue in the log
        const issueLog = log.data.issues.find(
          (i) => i.issueNumber === issueNumber,
        );
        if (issueLog && issueLog.phases.length > 0) {
          // Return the last executed phase
          const lastPhase = issueLog.phases[issueLog.phases.length - 1];
          return lastPhase.phase as Phase;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

/**
 * Discover worktrees that are not yet tracked in state
 *
 * Scans all git worktrees, identifies those with issue-related branch names,
 * and returns information about worktrees not yet in the state file.
 */
export async function discoverUntrackedWorktrees(
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  try {
    const worktrees = getWorktreeDetails();
    const discovered: DiscoveredWorktree[] = [];
    const skipped: SkippedWorktree[] = [];
    let alreadyTracked = 0;

    // Get existing state
    const manager = new StateManager({
      statePath: options.statePath,
      verbose: options.verbose,
    });
    const state = await manager.getState();
    const trackedIssues = new Set(
      Object.keys(state.issues).map((n) => parseInt(n, 10)),
    );

    for (const worktree of worktrees) {
      // Skip if no branch (detached HEAD)
      if (!worktree.branch) {
        skipped.push({
          path: worktree.path,
          reason: "detached HEAD (no branch)",
        });
        continue;
      }

      // Skip main/master branches
      if (worktree.branch === "main" || worktree.branch === "master") {
        skipped.push({
          path: worktree.path,
          reason: "main/master branch (not a feature worktree)",
        });
        continue;
      }

      // Try to parse issue number from branch
      const issueNumber = parseIssueNumberFromBranch(worktree.branch);
      if (issueNumber === null) {
        skipped.push({
          path: worktree.path,
          reason: `branch name doesn't match issue pattern: ${worktree.branch}`,
        });
        continue;
      }

      // Check if already tracked
      if (trackedIssues.has(issueNumber)) {
        alreadyTracked++;
        if (options.verbose) {
          console.log(
            `  Already tracked: #${issueNumber} (${worktree.branch})`,
          );
        }
        continue;
      }

      // Fetch title from GitHub
      if (options.verbose) {
        console.log(`  Fetching title for #${issueNumber}...`);
      }
      const title = fetchIssueTitle(issueNumber);

      // Try to infer phase from logs
      const inferredPhase = inferPhaseFromLogs(issueNumber);

      discovered.push({
        issueNumber,
        title,
        worktreePath: worktree.path,
        branch: worktree.branch,
        inferredPhase,
      });

      if (options.verbose) {
        console.log(
          `  Discovered: #${issueNumber} - ${title}${inferredPhase ? ` (phase: ${inferredPhase})` : ""}`,
        );
      }
    }

    return {
      success: true,
      worktreesScanned: worktrees.length,
      alreadyTracked,
      discovered,
      skipped,
    };
  } catch (error) {
    return {
      success: false,
      worktreesScanned: 0,
      alreadyTracked: 0,
      discovered: [],
      skipped: [],
      error: String(error),
    };
  }
}

// ============================================================================
// Auto-Reconciliation for Run Start (#305)
// ============================================================================

export interface ReconcileOptions {
  /** State file path (default: .sequant/state.json) */
  statePath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface ReconcileResult {
  /** Whether reconciliation was successful */
  success: boolean;
  /** Issues that were advanced from ready_for_merge to merged */
  advanced: number[];
  /** Issues checked but still ready_for_merge */
  stillPending: number[];
  /** Error message if failed */
  error?: string;
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
    const logResult = spawnSync(
      "git",
      [
        "log",
        "main",
        "--oneline",
        "-20",
        "--grep",
        `#${issueNumber}`,
        "--grep",
        `Merge #${issueNumber}`,
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

/**
 * Lightweight state reconciliation at run start
 *
 * Checks issues in `ready_for_merge` state and advances them to `merged`
 * if their PRs are merged or their branches are in main.
 *
 * This prevents re-running already completed issues.
 *
 * @param options - Reconciliation options
 * @returns Result with lists of advanced and still-pending issues
 */
export async function reconcileStateAtStartup(
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const manager = new StateManager({
    statePath: options.statePath,
    verbose: options.verbose,
  });

  // Graceful degradation: if state file doesn't exist, skip
  if (!manager.stateExists()) {
    return {
      success: true,
      advanced: [],
      stillPending: [],
    };
  }

  try {
    const state = await manager.getState();
    const advanced: number[] = [];
    const stillPending: number[] = [];

    // Find issues in ready_for_merge state
    for (const [issueNumStr, issueState] of Object.entries(state.issues)) {
      if (issueState.status !== "ready_for_merge") {
        continue;
      }

      const issueNum = parseInt(issueNumStr, 10);
      let isMerged = false;

      // Check 1: If we have PR info, check PR status via gh
      if (issueState.pr?.number) {
        const prStatus = checkPRMergeStatus(issueState.pr.number);
        if (prStatus === "MERGED") {
          isMerged = true;
          if (options.verbose) {
            console.log(
              `  #${issueNum}: PR #${issueState.pr.number} is merged`,
            );
          }
        }
      }

      // Check 2: If no PR or PR check failed, check git for merged branch
      if (!isMerged) {
        isMerged = isIssueMergedIntoMain(issueNum);
        if (isMerged && options.verbose) {
          console.log(`  #${issueNum}: Branch merged into main (git check)`);
        }
      }

      if (isMerged) {
        // Advance state to merged
        issueState.status = "merged";
        issueState.lastActivity = new Date().toISOString();
        advanced.push(issueNum);
      } else {
        stillPending.push(issueNum);
      }
    }

    // Save state if any issues were advanced
    if (advanced.length > 0) {
      await manager.saveState(state);
    }

    return {
      success: true,
      advanced,
      stillPending,
    };
  } catch (error) {
    return {
      success: false,
      advanced: [],
      stillPending: [],
      error: String(error),
    };
  }
}
