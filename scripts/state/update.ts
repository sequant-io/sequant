#!/usr/bin/env npx tsx
/**
 * CLI helper for workflow state updates
 *
 * Skills invoke this script to update .sequant/state.json when running standalone.
 * When SEQUANT_ORCHESTRATOR is set, the script exits early (orchestrator handles state).
 *
 * Usage:
 *   npx tsx scripts/state/update.ts start <issue> <phase>
 *   npx tsx scripts/state/update.ts complete <issue> <phase>
 *   npx tsx scripts/state/update.ts fail <issue> <phase> "<error>"
 *   npx tsx scripts/state/update.ts skip <issue> <phase>
 *   npx tsx scripts/state/update.ts init <issue> "<title>"
 *   npx tsx scripts/state/update.ts status <issue> <status>
 *   npx tsx scripts/state/update.ts iteration <issue> <iteration>
 *   npx tsx scripts/state/update.ts merged <issue>
 *
 * Examples:
 *   npx tsx scripts/state/update.ts start 119 exec
 *   npx tsx scripts/state/update.ts complete 119 exec
 *   npx tsx scripts/state/update.ts fail 119 qa "Tests failed"
 *   npx tsx scripts/state/update.ts init 119 "Add feature X"
 *   npx tsx scripts/state/update.ts status 119 ready_for_merge
 *   npx tsx scripts/state/update.ts merged 119
 */

import { StateManager } from "../../src/lib/workflow/state-manager.js";
import type {
  Phase,
  IssueStatus,
} from "../../src/lib/workflow/state-schema.js";

// Check if running in orchestrated mode
if (process.env.SEQUANT_ORCHESTRATOR) {
  // Orchestrator handles state - exit silently
  process.exit(0);
}

const [, , command, ...args] = process.argv;

if (!command) {
  console.error("Usage: npx tsx scripts/state/update.ts <command> <args>");
  console.error("");
  console.error("Commands:");
  console.error("  start <issue> <phase>         - Mark phase as in_progress");
  console.error("  complete <issue> <phase>      - Mark phase as completed");
  console.error("  fail <issue> <phase> <error>  - Mark phase as failed");
  console.error("  skip <issue> <phase>          - Mark phase as skipped");
  console.error("  init <issue> <title>          - Initialize issue tracking");
  console.error("  status <issue> <status>       - Update issue status");
  console.error("  iteration <issue> <n>         - Update loop iteration");
  console.error("  merged <issue>                - Mark issue as merged");
  process.exit(1);
}

const manager = new StateManager({ verbose: true });

async function main(): Promise<void> {
  try {
    switch (command) {
      case "start": {
        const [issueStr, phase] = args;
        const issueNumber = parseInt(issueStr, 10);
        if (isNaN(issueNumber) || !phase) {
          console.error("Usage: start <issue> <phase>");
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updatePhaseStatus(
          issueNumber,
          phase as Phase,
          "in_progress",
        );
        console.log(`📊 Phase '${phase}' started for issue #${issueNumber}`);
        break;
      }

      case "complete": {
        const [issueStr, phase] = args;
        const issueNumber = parseInt(issueStr, 10);
        if (isNaN(issueNumber) || !phase) {
          console.error("Usage: complete <issue> <phase>");
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updatePhaseStatus(
          issueNumber,
          phase as Phase,
          "completed",
        );
        console.log(`📊 Phase '${phase}' completed for issue #${issueNumber}`);
        break;
      }

      case "fail": {
        const [issueStr, phase, ...errorParts] = args;
        const issueNumber = parseInt(issueStr, 10);
        const error = errorParts.join(" ");
        if (isNaN(issueNumber) || !phase) {
          console.error('Usage: fail <issue> <phase> "<error>"');
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updatePhaseStatus(issueNumber, phase as Phase, "failed", {
          error: error || "Phase failed",
        });
        console.log(`📊 Phase '${phase}' failed for issue #${issueNumber}`);
        break;
      }

      case "skip": {
        const [issueStr, phase] = args;
        const issueNumber = parseInt(issueStr, 10);
        if (isNaN(issueNumber) || !phase) {
          console.error("Usage: skip <issue> <phase>");
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updatePhaseStatus(issueNumber, phase as Phase, "skipped");
        console.log(`📊 Phase '${phase}' skipped for issue #${issueNumber}`);
        break;
      }

      case "init": {
        const [issueStr, ...titleParts] = args;
        const issueNumber = parseInt(issueStr, 10);
        const title = titleParts.join(" ");
        if (isNaN(issueNumber) || !title) {
          console.error('Usage: init <issue> "<title>"');
          process.exit(1);
        }
        const existing = await manager.getIssueState(issueNumber);
        if (existing) {
          console.log(`📊 Issue #${issueNumber} already initialized, skipping`);
        } else {
          await manager.initializeIssue(issueNumber, title, {
            worktree: process.env.SEQUANT_WORKTREE,
          });
          console.log(`📊 Initialized issue #${issueNumber}: ${title}`);
        }
        break;
      }

      case "status": {
        const [issueStr, status] = args;
        const issueNumber = parseInt(issueStr, 10);
        if (isNaN(issueNumber) || !status) {
          console.error("Usage: status <issue> <status>");
          console.error(
            "Valid statuses: not_started, in_progress, ready_for_merge, merged, blocked, abandoned",
          );
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updateIssueStatus(issueNumber, status as IssueStatus);
        console.log(`📊 Issue #${issueNumber} status updated to '${status}'`);
        break;
      }

      case "iteration": {
        const [issueStr, iterStr] = args;
        const issueNumber = parseInt(issueStr, 10);
        const iteration = parseInt(iterStr, 10);
        if (isNaN(issueNumber) || isNaN(iteration)) {
          console.error("Usage: iteration <issue> <iteration>");
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updateLoopIteration(issueNumber, iteration);
        console.log(`📊 Loop iteration ${iteration} for issue #${issueNumber}`);
        break;
      }

      case "merged": {
        const [issueStr] = args;
        const issueNumber = parseInt(issueStr, 10);
        if (isNaN(issueNumber)) {
          console.error("Usage: merged <issue>");
          process.exit(1);
        }
        await ensureIssueExists(issueNumber);
        await manager.updateIssueStatus(issueNumber, "merged");
        console.log(`📊 Issue #${issueNumber} marked as merged`);
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error(
          "Valid commands: start, complete, fail, skip, init, status, iteration, merged",
        );
        process.exit(1);
    }
  } catch (error) {
    // State errors shouldn't stop skill execution - log and continue
    console.error(`⚠️  State update failed: ${error}`);
    // Exit with 0 to not break the calling skill
    process.exit(0);
  }
}

/**
 * Ensure issue exists in state, initialize if not
 */
async function ensureIssueExists(issueNumber: number): Promise<void> {
  const existing = await manager.getIssueState(issueNumber);
  if (!existing) {
    // Initialize with placeholder title - will be updated by skill
    await manager.initializeIssue(issueNumber, `Issue #${issueNumber}`, {
      worktree: process.env.SEQUANT_WORKTREE,
    });
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
