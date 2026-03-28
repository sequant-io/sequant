/**
 * sequant status - Show version, configuration, and workflow state
 */

import chalk from "chalk";
import { ui, colors } from "../lib/cli-ui.js";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { fileExists } from "../lib/fs.js";
import { readdir } from "fs/promises";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  rebuildStateFromLogs,
  cleanupStaleEntries,
} from "../lib/workflow/state-utils.js";
import {
  reconcileState,
  getNextActionHint,
  formatRelativeTime,
  type ReconcileResult,
} from "../lib/workflow/reconcile.js";
import {
  isTerminalStatus,
  type IssueState,
  type IssueStatus,
  type Phase,
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
  /** Remove all orphaned entries (both merged and abandoned) in one step */
  all?: boolean;
  /** Skip GitHub API queries (offline mode) */
  offline?: boolean;
}

/**
 * Run reconciliation and display warnings.
 * Returns the reconcile result for use in display.
 */
async function runReconciliation(
  stateManager: StateManager,
  options: StatusCommandOptions,
): Promise<ReconcileResult> {
  const result = await reconcileState({
    offline: options.offline,
    stateManager,
  });

  if (!options.json) {
    // Show reconciliation warnings
    if (result.warnings.length > 0) {
      console.log(chalk.yellow("\n  ⚠️  Drift detected:"));
      for (const w of result.warnings) {
        console.log(chalk.yellow(`    #${w.issueNumber}: ${w.description}`));
      }
    }

    // Show healed drift
    if (result.healed.length > 0) {
      for (const h of result.healed) {
        console.log(chalk.gray(`  ✓ Auto-healed: ${h.description}`));
      }
    }

    if (!result.githubReachable && !options.offline) {
      console.log(
        chalk.yellow(
          "\n  ⚠️  GitHub unreachable — showing cached data. Use --offline to suppress this warning.",
        ),
      );
    }
  }

  return result;
}

/**
 * Format age in days from an ISO timestamp
 */
function formatAgeDays(isoTimestamp: string | undefined): string {
  if (!isoTimestamp) return "";
  const age = Date.now() - new Date(isoTimestamp).getTime();
  const days = Math.floor(age / 86_400_000);
  if (days < 1) return "today";
  return `${days}d ago`;
}

/**
 * Color-code issue status, with age indicator for resolved issues
 */
function colorStatus(status: IssueStatus, resolvedAt?: string): string {
  const age = resolvedAt ? ` (${formatAgeDays(resolvedAt)})` : "";
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
      return chalk.green(status + age);
    case "blocked":
      return chalk.yellow(status);
    case "abandoned":
      return chalk.red(status + age);
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
  const status = colorStatus(issue.status, issue.resolvedAt);
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
  const relativeTime = formatRelativeTime(issue.lastActivity);
  lines.push(chalk.gray(`    Last activity: ${relativeTime}`));

  return lines.join("\n");
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

  // Display in priority order using a table
  const statusOrder: IssueStatus[] = [
    "in_progress",
    "waiting_for_qa_gate",
    "ready_for_merge",
    "blocked",
    "not_started",
    "merged",
    "abandoned",
  ];

  // Build rows for the table
  const rows: (string | number)[][] = [];
  for (const status of statusOrder) {
    const statusIssues = byStatus[status];
    for (const issue of statusIssues) {
      const title =
        issue.title.length > 30
          ? issue.title.substring(0, 27) + "..."
          : issue.title;
      const hint = getNextActionHint(issue);
      const hintDisplay = hint
        ? chalk.gray(
            `→ ${hint.length > 30 ? hint.substring(0, 27) + "..." : hint}`,
          )
        : "";
      rows.push([
        `#${issue.number}`,
        title,
        colorStatus(issue.status, issue.resolvedAt),
        issue.currentPhase || "-",
        hintDisplay,
      ]);
    }
  }

  // Display table
  console.log(
    "\n" +
      ui.table(rows, {
        columns: [
          { header: "Issue", width: 8 },
          { header: "Title", width: 32 },
          { header: "Status", width: 20 },
          { header: "Phase", width: 10 },
          { header: "Next", width: 34 },
        ],
      }),
  );

  // Summary counts
  const summary = [
    `Total: ${issues.length}`,
    byStatus.in_progress.length > 0
      ? colors.info(`In Progress: ${byStatus.in_progress.length}`)
      : null,
    byStatus.waiting_for_qa_gate.length > 0
      ? colors.warning(`QA Gate: ${byStatus.waiting_for_qa_gate.length}`)
      : null,
    byStatus.ready_for_merge.length > 0
      ? colors.success(`Ready: ${byStatus.ready_for_merge.length}`)
      : null,
    byStatus.blocked.length > 0
      ? colors.warning(`Blocked: ${byStatus.blocked.length}`)
      : null,
  ]
    .filter(Boolean)
    .join("  ");

  console.log(`\n  ${summary}`);
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

  console.log(ui.headerBox("SEQUANT STATUS"));
  console.log();

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
  console.log(chalk.gray(`Skills version: ${manifest.version}`));
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
      // Reconcile state with GitHub before displaying
      const reconcileResult = await runReconciliation(stateManager, options);

      // Re-read state after reconciliation (may have been updated)
      stateManager.clearCache();
      const allIssues = await stateManager.getAllIssueStates();
      const issues = Object.values(allIssues);

      if (issues.length > 0) {
        displayIssueSummary(issues);
      }

      // Last synced footer
      if (reconcileResult.lastSynced) {
        const syncedAgo = formatRelativeTime(reconcileResult.lastSynced);
        const offlineNote = options.offline ? " (offline)" : "";
        console.log(chalk.gray(`\n  Last synced: ${syncedAgo}${offlineNote}`));
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
    // Reconcile state with GitHub before displaying
    const reconcileResult = await runReconciliation(stateManager, options);
    stateManager.clearCache();

    if (options.issue !== undefined) {
      // Show single issue details
      const issueState = await stateManager.getIssueState(options.issue);

      if (options.json) {
        const jsonData = issueState
          ? {
              ...issueState,
              nextAction: getNextActionHint(issueState),
              lastSynced: reconcileResult.lastSynced,
            }
          : null;
        console.log(JSON.stringify(jsonData, null, 2));
      } else if (issueState) {
        console.log(chalk.bold(`\n📊 Issue #${options.issue} State\n`));
        console.log(formatIssueState(issueState));
        const hint = getNextActionHint(issueState);
        if (hint) {
          console.log(chalk.cyan(`\n    Next: ${hint}`));
        }
      } else {
        console.log(
          chalk.yellow(`\nIssue #${options.issue} not found in state.`),
        );
      }
    } else {
      // Show all issues (--all bypasses TTL filtering)
      const allIssues = options.all
        ? await stateManager.getAllIssueStatesUnfiltered()
        : await stateManager.getAllIssueStates();
      const issues = Object.values(allIssues);

      if (options.json) {
        // Enrich JSON output with next-action hints and lastSynced
        const enriched: Record<string, unknown> = {};
        for (const [key, issue] of Object.entries(
          (await stateManager.getState()).issues,
        )) {
          enriched[key] = {
            ...issue,
            nextAction: getNextActionHint(issue),
          };
        }
        console.log(
          JSON.stringify(
            {
              issues: enriched,
              lastSynced: reconcileResult.lastSynced,
              githubReachable: reconcileResult.githubReachable,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(chalk.bold("\n📊 Workflow State\n"));
        displayIssueSummary(issues);

        // Last synced footer
        const syncedAgo = formatRelativeTime(reconcileResult.lastSynced);
        const offlineNote = options.offline ? " (offline)" : "";
        console.log(chalk.gray(`\n  Last synced: ${syncedAgo}${offlineNote}`));
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
  const removeAll = options.all ?? false;

  if (!options.json) {
    if (dryRun) {
      console.log(chalk.bold("\n🧹 Cleanup preview (dry run)...\n"));
    } else if (removeAll) {
      console.log(chalk.bold("\n🧹 Cleaning up all orphaned entries...\n"));
    } else {
      console.log(chalk.bold("\n🧹 Cleaning up stale entries...\n"));
    }
  }

  const result = await cleanupStaleEntries({
    dryRun,
    maxAgeDays: options.maxAge,
    removeAll,
    verbose: !options.json,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.success) {
    const orphanedCount = result.orphaned.length;
    const removedCount = result.removed.length;
    const mergedCount = result.merged.length;

    if (orphanedCount === 0 && removedCount === 0 && mergedCount === 0) {
      console.log(chalk.green("✓ No stale entries found"));
    } else {
      if (dryRun) {
        console.log(chalk.yellow("Preview (no changes made):"));
      } else {
        console.log(chalk.green("✓ Cleanup completed"));
      }

      if (mergedCount > 0) {
        console.log(
          chalk.green(
            `  Merged PRs (auto-removed): ${result.merged.map((n) => `#${n}`).join(", ")}`,
          ),
        );
      }

      if (orphanedCount > 0) {
        const orphanedNotMerged = result.orphaned.filter(
          (n) => !result.merged.includes(n),
        );
        if (orphanedNotMerged.length > 0) {
          console.log(
            chalk.yellow(
              `  Abandoned (no merge): ${orphanedNotMerged.map((n) => `#${n}`).join(", ")}`,
            ),
          );
        }
      }

      if (removedCount > 0) {
        const removedNotMerged = result.removed.filter(
          (n) => !result.merged.includes(n),
        );
        if (removedNotMerged.length > 0) {
          console.log(
            chalk.gray(
              `  Removed: ${removedNotMerged.map((n) => `#${n}`).join(", ")}`,
            ),
          );
        }
      }

      if (dryRun) {
        console.log(
          chalk.gray("\nRun without --dry-run to apply these changes."),
        );
        if (!removeAll && orphanedCount > 0) {
          console.log(
            chalk.gray(
              "Use --all to remove both merged and abandoned entries.",
            ),
          );
        }
      }
    }
  } else {
    console.log(chalk.red(`✗ Cleanup failed: ${result.error}`));
  }
}
