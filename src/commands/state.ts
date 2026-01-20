/**
 * sequant state - Manage workflow state for existing worktrees
 *
 * Provides commands to bootstrap, rebuild, and clean up workflow state:
 * - init: Populate state for untracked worktrees
 * - rebuild: Recreate entire state from git worktrees + logs
 * - clean: Remove entries for worktrees that no longer exist
 */

import chalk from "chalk";
import { StateManager } from "../lib/workflow/state-manager.js";
import {
  rebuildStateFromLogs,
  cleanupStaleEntries,
  discoverUntrackedWorktrees,
  type DiscoverOptions,
  type DiscoverResult,
} from "../lib/workflow/state-utils.js";
import { createIssueState } from "../lib/workflow/state-schema.js";

export interface StateInitOptions {
  /** Output as JSON */
  json?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
}

export interface StateRebuildOptions {
  /** Output as JSON */
  json?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
  /** Force rebuild without confirmation (skip backup warning) */
  force?: boolean;
}

export interface StateCleanOptions {
  /** Output as JSON */
  json?: boolean;
  /** Enable verbose output */
  verbose?: boolean;
  /** Only show what would be cleaned (don't modify) */
  dryRun?: boolean;
  /** Remove entries older than this many days */
  maxAge?: number;
}

/**
 * Initialize state for untracked worktrees
 *
 * Scans for worktrees with issue-* or feature/* patterns,
 * extracts issue numbers, fetches titles from GitHub,
 * and populates state file with reasonable defaults.
 */
export async function stateInitCommand(
  options: StateInitOptions = {},
): Promise<void> {
  if (!options.json) {
    console.log(chalk.bold("\n🔍 Discovering untracked worktrees...\n"));
  }

  const discoverOptions: DiscoverOptions = {
    verbose: options.verbose && !options.json,
  };

  const result = await discoverUntrackedWorktrees(discoverOptions);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.log(chalk.red(`✗ Discovery failed: ${result.error}`));
    return;
  }

  if (result.discovered.length === 0) {
    console.log(chalk.green("✓ All worktrees are already tracked"));
    console.log(chalk.gray(`  Worktrees scanned: ${result.worktreesScanned}`));
    return;
  }

  // Initialize state for discovered worktrees
  const stateManager = new StateManager({ verbose: options.verbose });

  for (const worktree of result.discovered) {
    try {
      // Create issue state with worktree info
      const issueState = createIssueState(
        worktree.issueNumber,
        worktree.title,
        {
          worktree: worktree.worktreePath,
          branch: worktree.branch,
        },
      );

      // Set status based on inferred phase
      if (worktree.inferredPhase) {
        issueState.currentPhase = worktree.inferredPhase;
        issueState.status = "in_progress";
      }

      // Save to state
      const state = await stateManager.getState();
      state.issues[String(worktree.issueNumber)] = issueState;
      await stateManager.saveState(state);

      console.log(
        chalk.green(`✓ Added #${worktree.issueNumber}: ${worktree.title}`),
      );
      console.log(chalk.gray(`  Branch: ${worktree.branch}`));
      if (worktree.inferredPhase) {
        console.log(chalk.gray(`  Inferred phase: ${worktree.inferredPhase}`));
      }
      console.log("");
    } catch (error) {
      console.log(
        chalk.yellow(`⚠ Failed to add #${worktree.issueNumber}: ${error}`),
      );
    }
  }

  console.log(chalk.bold("\nSummary:"));
  console.log(chalk.gray(`  Worktrees scanned: ${result.worktreesScanned}`));
  console.log(chalk.gray(`  Already tracked: ${result.alreadyTracked}`));
  console.log(chalk.green(`  Newly added: ${result.discovered.length}`));

  if (result.skipped.length > 0) {
    console.log(chalk.yellow(`  Skipped: ${result.skipped.length}`));
    for (const skip of result.skipped) {
      console.log(chalk.gray(`    - ${skip.path}: ${skip.reason}`));
    }
  }
}

/**
 * Rebuild entire state from scratch
 *
 * Combines worktree discovery with log-based state reconstruction.
 * Creates backup of existing state before rebuilding.
 */
export async function stateRebuildCommand(
  options: StateRebuildOptions = {},
): Promise<void> {
  if (!options.json) {
    console.log(chalk.bold("\n🔄 Rebuilding state from scratch...\n"));

    if (!options.force) {
      console.log(
        chalk.yellow(
          "⚠ This will replace the existing state file. Use --force to proceed.\n",
        ),
      );
      return;
    }
  }

  // Step 1: Rebuild from logs
  if (!options.json) {
    console.log(chalk.gray("Step 1: Rebuilding from run logs..."));
  }

  const logResult = await rebuildStateFromLogs({
    verbose: options.verbose && !options.json,
  });

  if (!logResult.success) {
    if (options.json) {
      console.log(
        JSON.stringify({ success: false, error: logResult.error }, null, 2),
      );
    } else {
      console.log(chalk.red(`✗ Log rebuild failed: ${logResult.error}`));
    }
    return;
  }

  // Step 2: Discover and add untracked worktrees
  if (!options.json) {
    console.log(chalk.gray("Step 2: Discovering untracked worktrees..."));
  }

  const discoverResult = await discoverUntrackedWorktrees({
    verbose: options.verbose && !options.json,
  });

  if (!discoverResult.success) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { success: false, error: discoverResult.error },
          null,
          2,
        ),
      );
    } else {
      console.log(
        chalk.yellow(`⚠ Worktree discovery failed: ${discoverResult.error}`),
      );
      console.log(chalk.gray("  State rebuilt from logs only."));
    }
  } else {
    // Add discovered worktrees to state
    const stateManager = new StateManager({ verbose: options.verbose });

    for (const worktree of discoverResult.discovered) {
      try {
        const issueState = createIssueState(
          worktree.issueNumber,
          worktree.title,
          {
            worktree: worktree.worktreePath,
            branch: worktree.branch,
          },
        );

        if (worktree.inferredPhase) {
          issueState.currentPhase = worktree.inferredPhase;
          issueState.status = "in_progress";
        }

        const state = await stateManager.getState();
        // Only add if not already present from logs
        if (!state.issues[String(worktree.issueNumber)]) {
          state.issues[String(worktree.issueNumber)] = issueState;
          await stateManager.saveState(state);
        } else {
          // Update worktree info if missing
          const existing = state.issues[String(worktree.issueNumber)];
          if (!existing.worktree) {
            existing.worktree = worktree.worktreePath;
            existing.branch = worktree.branch;
            await stateManager.saveState(state);
          }
        }
      } catch {
        // Continue with other worktrees
      }
    }
  }

  // Output results
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          success: true,
          logsProcessed: logResult.logsProcessed,
          issuesFromLogs: logResult.issuesFound,
          worktreesScanned: discoverResult.worktreesScanned,
          worktreesAdded: discoverResult.discovered.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.green("\n✓ State rebuilt successfully"));
  console.log(chalk.gray(`  Logs processed: ${logResult.logsProcessed}`));
  console.log(chalk.gray(`  Issues from logs: ${logResult.issuesFound}`));
  console.log(
    chalk.gray(`  Worktrees scanned: ${discoverResult.worktreesScanned}`),
  );
  console.log(
    chalk.gray(`  Worktrees added: ${discoverResult.discovered.length}`),
  );

  console.log(
    chalk.gray("\nRun `sequant status --issues` to see the rebuilt state."),
  );
}

/**
 * Clean up orphaned state entries
 *
 * Removes entries for worktrees that no longer exist.
 */
export async function stateCleanCommand(
  options: StateCleanOptions = {},
): Promise<void> {
  const dryRun = options.dryRun ?? false;

  if (!options.json) {
    if (dryRun) {
      console.log(chalk.bold("\n🧹 Cleanup preview (dry run)...\n"));
    } else {
      console.log(chalk.bold("\n🧹 Cleaning up orphaned entries...\n"));
    }
  }

  const result = await cleanupStaleEntries({
    dryRun,
    maxAgeDays: options.maxAge,
    verbose: options.verbose && !options.json,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.log(chalk.red(`✗ Cleanup failed: ${result.error}`));
    return;
  }

  const orphanedCount = result.orphaned.length;
  const removedCount = result.removed.length;

  if (orphanedCount === 0 && removedCount === 0) {
    console.log(chalk.green("✓ No orphaned entries found"));
    return;
  }

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
      chalk.gray(`  Removed: ${result.removed.map((n) => `#${n}`).join(", ")}`),
    );
  }

  if (dryRun) {
    console.log(chalk.gray("\nRun without --dry-run to apply these changes."));
  }
}

/**
 * Main state command handler (routes to subcommands)
 */
export async function stateCommand(
  subcommand: string | undefined,
  options: StateInitOptions & StateRebuildOptions & StateCleanOptions = {},
): Promise<void> {
  switch (subcommand) {
    case "init":
      return stateInitCommand(options);
    case "rebuild":
      return stateRebuildCommand(options);
    case "clean":
      return stateCleanCommand(options);
    default:
      console.log(chalk.bold("\n📊 sequant state - Manage workflow state\n"));
      console.log("Available subcommands:");
      console.log(
        chalk.gray("  init     Populate state for untracked worktrees"),
      );
      console.log(
        chalk.gray("  rebuild  Recreate state from logs + worktrees"),
      );
      console.log(
        chalk.gray("  clean    Remove entries for deleted worktrees"),
      );
      console.log(
        chalk.gray(
          "\nRun `sequant state <subcommand> --help` for more information.",
        ),
      );
  }
}
