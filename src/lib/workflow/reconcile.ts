/**
 * Reconciliation engine for sequant status
 *
 * Reconciles local state.json with GitHub API and filesystem
 * to provide accurate, up-to-date status information.
 *
 * @module reconcile
 */

import * as fs from "fs";
import { StateManager } from "./state-manager.js";
import {
  GitHubProvider,
  type BatchIssueInfo,
  type BatchPRInfo,
} from "./platforms/github.js";
import type { IssueState, IssueStatus } from "./state-schema.js";

/**
 * Classification of detected drift between local state and reality.
 */
export type DriftType = "unambiguous" | "ambiguous" | "none";

/**
 * A single drift action detected during reconciliation.
 */
export interface DriftAction {
  issueNumber: number;
  type: DriftType;
  action: string;
  description: string;
}

/**
 * Result of a reconciliation operation.
 */
export interface ReconcileResult {
  success: boolean;
  /** Actions taken (unambiguous drift auto-healed). */
  healed: DriftAction[];
  /** Ambiguous drift flagged to user. */
  warnings: DriftAction[];
  /** ISO timestamp of when reconciliation completed. */
  lastSynced: string;
  /** Whether GitHub was reachable. */
  githubReachable: boolean;
  /** Error message if reconciliation failed entirely. */
  error?: string;
}

/**
 * Options for reconciliation.
 */
export interface ReconcileOptions {
  /** Skip GitHub API queries (offline mode). */
  offline?: boolean;
  /** State manager to use. */
  stateManager?: StateManager;
}

/**
 * Classify drift for a single issue based on GitHub and filesystem state.
 */
export function classifyDrift(
  issue: IssueState,
  githubIssue?: BatchIssueInfo,
  githubPR?: BatchPRInfo,
  worktreeExists?: boolean,
): DriftAction | null {
  const num = issue.number;

  // Check PR merge → unambiguous
  if (githubPR?.state === "MERGED" && issue.status !== "merged") {
    return {
      issueNumber: num,
      type: "unambiguous",
      action: "update_to_merged",
      description: `PR #${githubPR.number} merged on GitHub`,
    };
  }

  // Check issue closed + no merged PR → unambiguous abandoned
  if (
    githubIssue?.state === "CLOSED" &&
    issue.status !== "merged" &&
    issue.status !== "abandoned" &&
    githubPR?.state !== "MERGED"
  ) {
    return {
      issueNumber: num,
      type: "unambiguous",
      action: "update_to_abandoned",
      description: `Issue #${num} closed on GitHub without merged PR`,
    };
  }

  // Check worktree missing
  if (issue.worktree && worktreeExists === false) {
    // If issue is open and no PR → ambiguous
    if ((!githubIssue || githubIssue.state === "OPEN") && !issue.pr?.number) {
      return {
        issueNumber: num,
        type: "ambiguous",
        action: "flag_missing_worktree",
        description: `Worktree deleted but issue #${num} still open with no PR`,
      };
    }
    // Otherwise just clear worktree (unambiguous)
    return {
      issueNumber: num,
      type: "unambiguous",
      action: "clear_worktree",
      description: `Worktree path no longer exists for issue #${num}`,
    };
  }

  // Check local abandoned but GitHub open → ambiguous
  if (issue.status === "abandoned" && githubIssue?.state === "OPEN") {
    return {
      issueNumber: num,
      type: "ambiguous",
      action: "flag_status_mismatch",
      description: `Issue #${num} marked abandoned locally but still open on GitHub`,
    };
  }

  return null;
}

/**
 * Get a next-action hint for an issue based on its current state.
 */
export function getNextActionHint(issue: IssueState): string {
  switch (issue.status) {
    case "not_started":
      return `sequant run ${issue.number}`;
    case "in_progress": {
      // Suggest resuming at current phase or next phase
      if (issue.currentPhase) {
        const failedPhase = Object.entries(issue.phases).find(
          ([, ps]) => ps.status === "failed",
        );
        if (failedPhase) {
          return `sequant run ${issue.number} --phase ${failedPhase[0]}`;
        }
      }
      return `sequant run ${issue.number}`;
    }
    case "waiting_for_qa_gate":
      return `sequant run ${issue.number} --phase qa`;
    case "ready_for_merge":
      if (issue.pr?.number) {
        return `gh pr merge ${issue.pr.number}`;
      }
      return `gh pr merge`;
    case "blocked":
      return `resolve blockers, then sequant run ${issue.number}`;
    case "merged":
      return `sequant status --cleanup`;
    case "abandoned":
      return `reopen issue or sequant status --cleanup`;
    default:
      return "";
  }
}

/**
 * Format a relative time string from an ISO timestamp.
 */
export function formatRelativeTime(isoTimestamp: string | undefined): string {
  if (!isoTimestamp) return "unknown";

  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) return "unknown";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Handle future timestamps (clock skew)
  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? "s" : ""} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;
  return date.toLocaleDateString();
}

/**
 * Reconcile local workflow state with GitHub and filesystem.
 *
 * This is the main entry point for reconciliation. Called by:
 * - `sequant status` (CLI)
 * - `sequant_status` (MCP tool)
 */
export async function reconcileState(
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const stateManager = options.stateManager ?? new StateManager();
  const now = new Date().toISOString();

  if (!stateManager.stateExists()) {
    return {
      success: true,
      healed: [],
      warnings: [],
      lastSynced: now,
      githubReachable: !options.offline,
    };
  }

  try {
    const state = await stateManager.getState();
    const issues = Object.values(state.issues);

    if (issues.length === 0) {
      state.lastSynced = now;
      await stateManager.saveState(state);
      return {
        success: true,
        healed: [],
        warnings: [],
        lastSynced: now,
        githubReachable: !options.offline,
      };
    }

    // Collect issue and PR numbers to query
    const issueNumbers = issues.map((i) => i.number);
    const prNumbers = issues
      .filter((i) => i.pr?.number)
      .map((i) => i.pr!.number);

    // Batch fetch from GitHub (unless offline)
    let githubIssues: Record<number, BatchIssueInfo> = {};
    let githubPRs: Record<number, BatchPRInfo> = {};
    let githubReachable = false;

    if (!options.offline) {
      const github = new GitHubProvider();
      const batchResult = github.batchFetchIssueAndPRStatus(
        issueNumbers,
        prNumbers,
      );

      if (!batchResult.error) {
        githubIssues = batchResult.issues;
        githubPRs = batchResult.pullRequests;
        githubReachable = true;
      }
      // On error: graceful degradation — proceed with cached data
    }

    // Check filesystem for worktrees
    const worktreeExists: Record<number, boolean> = {};
    for (const issue of issues) {
      if (issue.worktree) {
        worktreeExists[issue.number] = fs.existsSync(issue.worktree);
      }
    }

    // Classify and apply drift
    const healed: DriftAction[] = [];
    const warnings: DriftAction[] = [];
    let stateModified = false;

    for (const issue of issues) {
      const issueKey = String(issue.number);
      const ghIssue = githubIssues[issue.number];
      const ghPR = issue.pr?.number ? githubPRs[issue.pr.number] : undefined;
      const wtExists = issue.worktree
        ? worktreeExists[issue.number]
        : undefined;

      // Update title from GitHub if available
      if (ghIssue?.title && ghIssue.title !== issue.title) {
        state.issues[issueKey].title = ghIssue.title;
        stateModified = true;
      }

      const drift = classifyDrift(issue, ghIssue, ghPR, wtExists);

      // Always clear missing worktrees independently of other drift
      if (issue.worktree && wtExists === false && drift?.type !== "ambiguous") {
        state.issues[issueKey].worktree = undefined;
        stateModified = true;
      }

      if (!drift) continue;

      if (drift.type === "unambiguous") {
        // Auto-heal
        switch (drift.action) {
          case "update_to_merged":
            state.issues[issueKey].status = "merged" as IssueStatus;
            state.issues[issueKey].lastActivity = now;
            stateModified = true;
            break;
          case "update_to_abandoned":
            state.issues[issueKey].status = "abandoned" as IssueStatus;
            state.issues[issueKey].lastActivity = now;
            stateModified = true;
            break;
          case "clear_worktree":
            state.issues[issueKey].worktree = undefined;
            state.issues[issueKey].lastActivity = now;
            stateModified = true;
            break;
        }
        healed.push(drift);
      } else {
        // Flag to user
        warnings.push(drift);
      }
    }

    // Persist if changed
    if (stateModified || githubReachable) {
      state.lastSynced = now;
      await stateManager.saveState(state);
    }

    return {
      success: true,
      healed,
      warnings,
      lastSynced: now,
      githubReachable,
    };
  } catch (error) {
    return {
      success: false,
      healed: [],
      warnings: [],
      lastSynced: now,
      githubReachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
