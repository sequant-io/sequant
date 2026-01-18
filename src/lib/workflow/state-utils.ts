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
  type WorkflowState,
  type IssueState,
  type Phase,
  createEmptyState,
  createIssueState,
  createPhaseState,
} from "./state-schema.js";
import { RunLogSchema, type RunLog, LOG_PATHS } from "./run-log-schema.js";

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
}

export interface CleanupResult {
  /** Whether cleanup was successful */
  success: boolean;
  /** Issues that were removed or would be removed */
  removed: number[];
  /** Issues that were marked as orphaned */
  orphaned: number[];
  /** Error message if failed */
  error?: string;
}

/**
 * Clean up stale and orphaned entries from workflow state
 *
 * - Removes issues with non-existent worktrees (orphaned)
 * - Optionally removes old merged/abandoned issues
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
    };
  }

  try {
    const state = await manager.getState();
    const removed: number[] = [];
    const orphaned: number[] = [];

    // Get list of active worktrees
    const activeWorktrees = getActiveWorktrees();

    for (const [issueNumStr, issueState] of Object.entries(state.issues)) {
      const issueNum = parseInt(issueNumStr, 10);

      // Check if worktree exists (if issue has one)
      if (
        issueState.worktree &&
        !activeWorktrees.includes(issueState.worktree)
      ) {
        orphaned.push(issueNum);

        if (options.verbose) {
          console.log(
            `🗑️  Orphaned: #${issueNum} (worktree not found: ${issueState.worktree})`,
          );
        }

        if (!options.dryRun) {
          // Mark as abandoned or remove based on status
          if (
            issueState.status === "merged" ||
            issueState.status === "abandoned"
          ) {
            removed.push(issueNum);
            delete state.issues[issueNumStr];
          } else {
            // Update status to indicate orphaned state
            issueState.status = "abandoned";
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
    };
  } catch (error) {
    return {
      success: false,
      removed: [],
      orphaned: [],
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
