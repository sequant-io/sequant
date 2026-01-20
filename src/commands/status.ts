/**
 * sequant status - Show version, configuration, and workflow state
 */

import chalk from "chalk";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { fileExists } from "../lib/fs.js";
import { readdir } from "fs/promises";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  rebuildStateFromLogs,
  cleanupStaleEntries,
} from "../lib/workflow/state-utils.js";
import type {
  IssueState,
  IssueStatus,
  Phase,
} from "../lib/workflow/state-schema.js";

export interface StatusCommandOptions {
  /** Show only issues state */
  issues?: boolean;
  /** Show details for a specific issue */
  issue?: number;
  /** Output as JSON */
  json?: boolean;
  /** Rebuild state from run logs */
  rebuild?: boolean;
  /** Clean up stale/orphaned entries */
  cleanup?: boolean;
  /** Only show what would be cleaned (used with --cleanup) */
  dryRun?: boolean;
  /** Remove entries older than this many days (used with --cleanup) */
  maxAge?: number;
}

/**
 * Color-code issue status
 */
function colorStatus(status: IssueStatus): string {
  switch (status) {
    case "not_started":
      return chalk.gray(status);
    case "in_progress":
      return chalk.blue(status);
    case "waiting_for_qa_gate":
      return chalk.yellow(status);
    case "ready_for_merge":
      return chalk.green(status);
    case "merged":
      return chalk.green(status);
    case "blocked":
      return chalk.yellow(status);
    case "abandoned":
      return chalk.red(status);
    default:
      return status;
  }
}

/**
 * Get phase status symbol
 */
function getPhaseSymbol(phaseState: { status: string } | undefined): string {
  if (!phaseState) return chalk.gray("○");

  switch (phaseState.status) {
    case "pending":
      return chalk.gray("○");
    case "in_progress":
      return chalk.blue("◐");
    case "completed":
      return chalk.green("●");
    case "failed":
      return chalk.red("✗");
    case "skipped":
      return chalk.gray("-");
    default:
      return chalk.gray("?");
  }
}

/**
 * Format a single issue state for display
 */
function formatIssueState(issue: IssueState): string {
  const lines: string[] = [];

  // Issue header
  lines.push(
    chalk.bold(
      `  #${issue.number}: ${issue.title.substring(0, 50)}${issue.title.length > 50 ? "..." : ""}`,
    ),
  );

  // Status and current phase
  const status = colorStatus(issue.status);
  const currentPhase = issue.currentPhase
    ? chalk.cyan(issue.currentPhase)
    : chalk.gray("none");
  lines.push(`    Status: ${status}  Current: ${currentPhase}`);

  // Phase progress bar
  const phases: Phase[] = [
    "spec",
    "security-review",
    "exec",
    "testgen",
    "test",
    "qa",
    "loop",
  ];
  const phaseProgress = phases
    .map((p) => getPhaseSymbol(issue.phases[p]))
    .join(" ");
  lines.push(`    Phases: ${phaseProgress}`);
  lines.push(
    `            ${phases.map((p) => p.charAt(0).toUpperCase()).join(" ")}`,
  );

  // PR info
  if (issue.pr) {
    lines.push(chalk.gray(`    PR: #${issue.pr.number} ${issue.pr.url}`));
  }

  // Worktree
  if (issue.worktree) {
    lines.push(chalk.gray(`    Worktree: ${issue.worktree}`));
  }

  // Last activity
  const lastActivity = new Date(issue.lastActivity);
  const relativeTime = getRelativeTime(lastActivity);
  lines.push(chalk.gray(`    Last activity: ${relativeTime}`));

  return lines.join("\n");
}

/**
 * Get relative time string
 */
function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
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
 * Display issue state summary table
 */
function displayIssueSummary(issues: IssueState[]): void {
  if (issues.length === 0) {
    console.log(chalk.gray("\n  No issues being tracked."));
    console.log(chalk.gray("  Run `sequant run <issue>` to start tracking."));
    return;
  }

  console.log(chalk.bold("\n  Tracked Issues:\n"));

  // Group by status
  const byStatus: Record<IssueStatus, IssueState[]> = {
    in_progress: [],
    waiting_for_qa_gate: [],
    ready_for_merge: [],
    blocked: [],
    not_started: [],
    merged: [],
    abandoned: [],
  };

  for (const issue of issues) {
    byStatus[issue.status].push(issue);
  }

  // Display in priority order
  const statusOrder: IssueStatus[] = [
    "in_progress",
    "waiting_for_qa_gate",
    "ready_for_merge",
    "blocked",
    "not_started",
    "merged",
    "abandoned",
  ];

  for (const status of statusOrder) {
    const statusIssues = byStatus[status];
    if (statusIssues.length === 0) continue;

    for (const issue of statusIssues) {
      console.log(formatIssueState(issue));
      console.log("");
    }
  }

  // Summary counts
  const summary = [
    `Total: ${issues.length}`,
    byStatus.in_progress.length > 0
      ? chalk.blue(`In Progress: ${byStatus.in_progress.length}`)
      : null,
    byStatus.waiting_for_qa_gate.length > 0
      ? chalk.yellow(`QA Gate: ${byStatus.waiting_for_qa_gate.length}`)
      : null,
    byStatus.ready_for_merge.length > 0
      ? chalk.green(`Ready: ${byStatus.ready_for_merge.length}`)
      : null,
    byStatus.blocked.length > 0
      ? chalk.yellow(`Blocked: ${byStatus.blocked.length}`)
      : null,
  ]
    .filter(Boolean)
    .join("  ");

  console.log(chalk.gray(`  ${summary}`));
}

export async function statusCommand(
  options: StatusCommandOptions = {},
): Promise<void> {
  // Handle --rebuild flag
  if (options.rebuild) {
    await handleRebuild(options);
    return;
  }

  // Handle --cleanup flag
  if (options.cleanup) {
    await handleCleanup(options);
    return;
  }

  // If --issues or --issue flag, focus on issue state
  if (options.issues || options.issue !== undefined) {
    await displayIssueState(options);
    return;
  }

  console.log(chalk.bold("\n📊 Sequant Status\n"));

  // Package version
  console.log(chalk.gray(`Package version: ${getPackageVersion()}`));

  // Check initialization
  const manifest = await getManifest();
  if (!manifest) {
    console.log(chalk.yellow("Status: Not initialized"));
    console.log(chalk.gray("\nRun `sequant init` to get started."));
    return;
  }

  console.log(chalk.green("Status: Initialized"));
  console.log(chalk.gray(`Installed version: ${manifest.version}`));
  console.log(chalk.gray(`Stack: ${manifest.stack}`));
  console.log(chalk.gray(`Installed: ${manifest.installedAt}`));
  if (manifest.updatedAt) {
    console.log(chalk.gray(`Last updated: ${manifest.updatedAt}`));
  }

  // Count skills
  const skillsDir = ".claude/skills";
  if (await fileExists(skillsDir)) {
    try {
      const skills = await readdir(skillsDir);
      const skillCount = skills.filter((s) => !s.startsWith(".")).length;
      console.log(chalk.gray(`Skills: ${skillCount}`));
    } catch {
      // Ignore errors
    }
  }

  // Check for local customizations
  const localDir = ".claude/.local";
  if (await fileExists(localDir)) {
    console.log(chalk.blue("Custom overrides: Yes (.claude/.local/)"));
  }

  // Show issue state summary
  const stateManager = new StateManager();
  if (stateManager.stateExists()) {
    try {
      const allIssues = await stateManager.getAllIssueStates();
      const issues = Object.values(allIssues);

      if (issues.length > 0) {
        displayIssueSummary(issues);
      }
    } catch {
      // Ignore state read errors
    }
  }

  console.log(chalk.gray("\nRun `sequant doctor` for detailed health check."));
  console.log(
    chalk.gray("Run `sequant status --issues` to see all tracked issues."),
  );
}

/**
 * Display detailed issue state
 */
async function displayIssueState(options: StatusCommandOptions): Promise<void> {
  const stateManager = new StateManager();

  if (!stateManager.stateExists()) {
    if (options.json) {
      console.log(JSON.stringify({ issues: {} }, null, 2));
    } else {
      console.log(chalk.yellow("\nNo workflow state found."));
      console.log(chalk.gray("Run `sequant run <issue>` to start tracking."));
    }
    return;
  }

  try {
    if (options.issue !== undefined) {
      // Show single issue details
      const issueState = await stateManager.getIssueState(options.issue);

      if (options.json) {
        console.log(JSON.stringify(issueState, null, 2));
      } else if (issueState) {
        console.log(chalk.bold(`\n📊 Issue #${options.issue} State\n`));
        console.log(formatIssueState(issueState));
      } else {
        console.log(
          chalk.yellow(`\nIssue #${options.issue} not found in state.`),
        );
      }
    } else {
      // Show all issues
      const allIssues = await stateManager.getAllIssueStates();
      const issues = Object.values(allIssues);

      if (options.json) {
        console.log(JSON.stringify({ issues: allIssues }, null, 2));
      } else {
        console.log(chalk.bold("\n📊 Workflow State\n"));
        displayIssueSummary(issues);
      }
    }
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ error: String(error) }, null, 2));
    } else {
      console.log(chalk.red(`\nError reading state: ${error}`));
    }
  }
}

/**
 * Handle --rebuild flag: Rebuild state from run logs
 */
async function handleRebuild(options: StatusCommandOptions): Promise<void> {
  if (!options.json) {
    console.log(chalk.bold("\n🔄 Rebuilding state from logs...\n"));
  }

  const result = await rebuildStateFromLogs({ verbose: !options.json });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    console.log(chalk.green("✓ State rebuilt successfully"));
    console.log(chalk.gray(`  Logs processed: ${result.logsProcessed}`));
    console.log(chalk.gray(`  Issues found: ${result.issuesFound}`));

    if (result.issuesFound > 0) {
      console.log(
        chalk.gray("\nRun `sequant status --issues` to see rebuilt state."),
      );
    }
  } else {
    console.log(chalk.red(`✗ Rebuild failed: ${result.error}`));
  }
}

/**
 * Handle --cleanup flag: Clean up stale/orphaned entries
 */
async function handleCleanup(options: StatusCommandOptions): Promise<void> {
  const dryRun = options.dryRun ?? false;

  if (!options.json) {
    if (dryRun) {
      console.log(chalk.bold("\n🧹 Cleanup preview (dry run)...\n"));
    } else {
      console.log(chalk.bold("\n🧹 Cleaning up stale entries...\n"));
    }
  }

  const result = await cleanupStaleEntries({
    dryRun,
    maxAgeDays: options.maxAge,
    verbose: !options.json,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    const orphanedCount = result.orphaned.length;
    const removedCount = result.removed.length;

    if (orphanedCount === 0 && removedCount === 0) {
      console.log(chalk.green("✓ No stale entries found"));
    } else {
      if (dryRun) {
        console.log(chalk.yellow("Preview (no changes made):"));
      } else {
        console.log(chalk.green("✓ Cleanup completed"));
      }

      if (orphanedCount > 0) {
        console.log(
          chalk.gray(
            `  Orphaned (worktree missing): ${result.orphaned.map((n) => `#${n}`).join(", ")}`,
          ),
        );
      }

      if (removedCount > 0) {
        console.log(
          chalk.gray(
            `  Removed: ${result.removed.map((n) => `#${n}`).join(", ")}`,
          ),
        );
      }

      if (dryRun) {
        console.log(
          chalk.gray("\nRun without --dry-run to apply these changes."),
        );
      }
    }
  } else {
    console.log(chalk.red(`✗ Cleanup failed: ${result.error}`));
  }
}
