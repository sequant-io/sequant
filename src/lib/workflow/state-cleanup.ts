/**
 * State cleanup and reconciliation utilities
 *
 * @module state-cleanup
 * @example
 * ```typescript
 * import { cleanupStaleEntries, reconcileStateAtStartup } from './state-cleanup';
 *
 * // Clean up orphaned entries
 * const result = await cleanupStaleEntries({ dryRun: true });
 * console.log(`Would remove ${result.removed.length} entries`);
 *
 * // Reconcile state at startup
 * const reconcileResult = await reconcileStateAtStartup();
 * console.log(`Advanced ${reconcileResult.advanced.length} issues to merged`);
 * ```
 */

import { spawnSync } from "child_process";
import { StateManager } from "./state-manager.js";
import { checkPRMergeStatus, isIssueMergedIntoMain } from "./pr-status.js";

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
