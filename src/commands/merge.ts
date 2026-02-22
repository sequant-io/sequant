/**
 * sequant merge - Batch-level integration QA for completed runs
 *
 * Runs deterministic checks on feature branches from a `sequant run` batch
 * to catch integration issues before human review.
 *
 * Phases:
 * - --check (Phase 1): Combined branch test, mirroring, overlap detection
 * - --scan  (Phase 1+2): Adds residual pattern detection
 * - --review (Phase 1+2+3): Adds AI briefing (stub)
 * - --all: Runs all phases
 * - --post: Post report to GitHub PRs
 */

import { spawnSync } from "child_process";
import { ui, colors } from "../lib/cli-ui.js";
import {
  runMergeChecks,
  formatReportMarkdown,
} from "../lib/merge-check/index.js";
import type { MergeCommandOptions } from "../lib/merge-check/types.js";

/**
 * Determine exit code from batch verdict
 */
export function getExitCode(batchVerdict: string): number {
  switch (batchVerdict) {
    case "READY":
      return 0;
    case "NEEDS_ATTENTION":
      return 1;
    case "BLOCKED":
      return 2;
    default:
      return 1;
  }
}

/**
 * Get the git repository root
 */
function getRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error("Not in a git repository");
  }
  return result.stdout.trim();
}

/**
 * Main merge command handler
 */
export async function mergeCommand(
  issues: string[],
  options: MergeCommandOptions,
): Promise<void> {
  // Default to --check if no phase flag is specified
  if (!options.check && !options.scan && !options.review && !options.all) {
    options.check = true;
  }

  const repoRoot = getRepoRoot();
  const issueNumbers = issues
    .map((i) => parseInt(i, 10))
    .filter((n) => !isNaN(n));

  // Determine mode label
  let mode = "check";
  if (options.all) mode = "all";
  else if (options.review) mode = "review";
  else if (options.scan) mode = "scan";

  if (!options.json) {
    console.log(ui.headerBox("SEQUANT MERGE"));
    console.log("");
    console.log(
      colors.muted(
        issueNumbers.length > 0
          ? `Checking issues: ${issueNumbers.map((i) => `#${i}`).join(", ")} (mode: ${mode})`
          : `Auto-detecting issues from most recent run (mode: ${mode})`,
      ),
    );
    console.log("");
  }

  try {
    const report = await runMergeChecks(issueNumbers, options, repoRoot);

    if (options.json) {
      // JSON output: serialize the report (convert Map to object)
      const jsonReport = {
        ...report,
        issueVerdicts: Object.fromEntries(report.issueVerdicts),
      };
      console.log(JSON.stringify(jsonReport, null, 2));
    } else {
      // Markdown output
      const markdown = formatReportMarkdown(report);
      console.log(markdown);

      // Phase 3 stub
      if (options.review || options.all) {
        console.log("");
        console.log(
          colors.muted(
            "Phase 3 (AI briefing) is not yet implemented. Use --check or --scan for deterministic checks.",
          ),
        );
      }
    }

    // Set exit code based on verdict
    const exitCode = getExitCode(report.batchVerdict);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (options.json) {
      console.log(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(ui.errorBox("Merge Check Failed", message));
    }
    process.exitCode = 2;
  }
}
